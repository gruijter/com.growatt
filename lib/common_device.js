/*
Copyright 2025 - 2026, Robin de Gruijter (rmdegruijter@gmail.com)

This file is part of com.growatt.

com.growatt is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.growatt is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.growatt.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const Homey = require('homey');
const util = require('util');
const growattMap = require('./growattMap');
const { deviceTitles } = require('./capabilityTitles');

const setTimeoutPromise = util.promisify(setTimeout);

// The API has no single field carrying a product name, so this picks the best of three, in order:
//
//  - alias / treeName is the device label the user set in ShinePhone, and is often the real model
//    ('MOD 8KTL3-XH' on FQP0E3D0JR). It DEFAULTS to the serial number though (RDL3CL30A8 and
//    CT04130016 both read that way), so it only counts when it differs from the serial.
//  - modelText is present on every inverter type but is a Growatt option code
//    ('S3EB08D00T00P0FU01M0032' on min, 'A0B0D0T0PFU1M4S1' on inv). Both vendor OpenAPI PDFs
//    describe the field only as "Device model" and document no way to decode it, so it is passed
//    through as-is rather than turned into a product name.
//  - model is a readable name on noah ('Noah 2000') and a 64-bit numeric blob on inv/min
//    (61761, 4469822630416941000), so it is used only when it is a non-numeric string. noah has no
//    modelText at all, which is why this third step exists.
//
// Returns undefined when none of them yields anything, leaving the setting untouched.
const deviceModel = (info, deviceSn) => {
  const alias = String(info.alias ?? info.treeName ?? '').trim();
  if (alias && alias !== deviceSn) return alias;
  const modelText = String(info.modelText ?? '').trim();
  if (modelText) return modelText;
  const { model } = info;
  if (typeof model === 'string' && model.trim() && Number.isNaN(Number(model))) return model.trim();
  return undefined;
};

module.exports = class MyDevice extends Homey.Device {

  async onInit() {
    try {
      this.restarting = false;
      this.busy = false;
      this.rawSampleLogged = false; // log one raw API sample per restart, for diagnostics reports
      this.invalidCapsLogged = new Set(); // log each capability's first invalid-value mapping once per restart
      this.emptyDeviceTypeLogged = false; // log once per restart when lastData has no entries at all for this deviceType (see #20)
      this.permissionDeniedCount = 0; // consecutive PERMISSION_DENIED polls, reset on success
      this.lastPoll = Date.now(); // Initialize so the watchdog timer works immediately
      await this.setAvailable();
      this.deviceType = this.getSettings().deviceType;
      this.deviceSn = this.getSettings().deviceSn;
      this.growatt = this.homey.app.getSession(this.getSettings());
      // check for capability migration
      if (await this.migrate()) return;
      // await this.initSpecials(); // Initialize required control authorities
      this.startListeners();
      // poll lastData is handled by app.js grouped poll on boot
      // await this.pollLastData();
      // start polling non-lastData
      await this.startPolling();
      // fetch power limits in the background: this hits the network and must not delay
      // onInit(), since Growatt API calls are globally rate-limited (min. 3s apart) and
      // can otherwise push the whole app past Homey's boot ready_timeout with multiple devices
      this.fetchDeviceInfo().catch((error) => this.error(error));
      this.log(this.getName(), 'has been initialized');
    } catch (error) {
      this.error(error);
      this.setUnavailable(error.message || error).catch(this.error);
      this.restarting = false;
      this.restartDevice(60 * 1000).catch((error) => this.error(error));
    }
  }

  async pollLastData() {
    try {
      const device = {
        username: this.getSettings().username,
        token: this.getSettings().token,
        host: this.getSettings().host,
        deviceSn: this.deviceSn,
        deviceType: this.deviceType,
      };
      await this.homey.app.pollDevice(device);
    } catch (error) {
      this.error(error);
    }
  }

  // fetch nominalPower / maxChargePower / maxDischargePower and the model name from the API and
  // store them as settings. Runs in the background (called without awaiting from onInit()) since it
  // hits the globally rate-limited Growatt API and must not delay device/app boot.
  //
  // The model gets its own term in the guard rather than riding along on the power one: a device
  // paired before the model was ever read has nominalPower filled already, so a power-only guard
  // returns before getDeviceInfo() is called and the model would stay empty forever. Each condition
  // still only fires while its own setting is missing, so a device that has both makes no API call.
  async fetchDeviceInfo() {
    const initialSettings = this.getSettings();
    let needsFetch = !initialSettings.nominalPower || !initialSettings.model;
    if (this.driver.id === 'battery2' && (!initialSettings.maxChargePower || !initialSettings.maxDischargePower)) {
      needsFetch = true;
    }
    if (!needsFetch) return;

    const devInfo = await this.growatt.getDeviceInfo({ deviceSn: this.deviceSn, deviceType: this.deviceType })
      .catch((e) => this.error('Failed to fetch device info', e.message || e));
    if (!devInfo || this.restarting) return;
    const thisDeviceTypeData = devInfo[`${this.deviceType}`] || [];
    const deviceInfo = thisDeviceTypeData.find((d) => (
      d.serialNum || d.deviceSn || d.inverterId || d.mixSn || d.spaSn
      || d.hpsSn || d.tlxSn || d.maxSn || d.pcsSn
    ) === this.deviceSn);
    if (!deviceInfo) {
      this.log('device not found in devInfo', devInfo);
      return;
    }
    this.log(`Raw deviceInfo sample for ${this.getName()} (${this.driver.id}/${this.deviceType}):`, JSON.stringify(deviceInfo));
    const pmax = Number(deviceInfo.pmax || deviceInfo.nominalPower || 0);
    const chargeMax = Number(deviceInfo.maxChargePower || deviceInfo.chargePower || pmax);
    const dischargeMax = Number(deviceInfo.maxDischargePower || deviceInfo.dischargePower || pmax);
    if (pmax || chargeMax || dischargeMax) {
      this.log(`Setting nominalPower to ${pmax}, maxChargePower to ${chargeMax}, maxDischargePower to ${dischargeMax}`);
      if (pmax) await this.setSetting('nominalPower', pmax);
      if (chargeMax) await this.setSetting('maxChargePower', chargeMax);
      if (dischargeMax) await this.setSetting('maxDischargePower', dischargeMax);
    } else this.log('power limits not found in deviceInfo', deviceInfo);

    const model = deviceModel(deviceInfo, this.deviceSn);
    if (model && model !== initialSettings.model) {
      this.log(`Setting model to '${model}'`);
      await this.setSetting('model', model);
    } else if (!model) this.log('model not found in deviceInfo', deviceInfo);
  }

  // getCapabilityOptions() throws 'Invalid Capability' for a capability that has no options
  // stored, even though hasCapability() returns true for it - a capability the driver declares no
  // capabilitiesOptions for in compose hits this (meter_power on inverter2 is the case that
  // surfaced it). Read a throw as "no options yet" instead of letting it abort the caller.
  capabilityOptions(capability) {
    try {
      return this.getCapabilityOptions(capability) || {};
    } catch (error) {
      return {};
    }
  }

  // The capability set and value mappings for this device. inverter2 resolves them per device
  // because a hybrid with no battery history presents as a string inverter (see growattMap.js
  // #inverterCapabilities); every other driver takes its map verbatim. Reading the STORED verdict
  // rather than the live payload keeps migrate() and the pollers on one answer - #handleLastData
  // restarts the device when the verdict flips, so migrate() rebuilds the set on the way back up.
  capabilityMap() {
    if (this.driver.id !== 'inverter2') return growattMap[`${this.driver.id}Map`][this.deviceType];
    const stored = this.getStoreValue('hasBattery');
    return growattMap.inverterCapabilities(this.deviceType, stored === null ? undefined : stored);
  }

  // Some inverter2 titles depend on the device type, which capabilitiesOptions cannot express
  // because one driver serves nine types: meter_power/meter_power.today carry solar yield on the AC
  // side for string inverters and on the DC side for hybrids, and a noah relabels measure_power and
  // measure_efficiency outright (see capabilityTitles.js). So the title is stamped per device here.
  // Merges onto the MANIFEST options rather than the device's current ones, so repeated calls start
  // from a clean base and cannot compound - the same rule com.gruijter.powerhour follows in
  // drivers/grid/device.js.
  async syncCapabilityTitles() {
    // hasBattery is stored by #handleLastData, so a title stamped at migrate() time already
    // reflects the last poll's verdict. null (never polled) is passed through as undefined, which
    // deviceTitles() treats as "cannot tell" and leaves on the DC default.
    const stored = this.getStoreValue('hasBattery');
    const titles = deviceTitles(this.deviceType, stored === null ? undefined : stored);
    const manifestOptions = this.homey.app.manifest.drivers
      .find((d) => d.id === this.driver.id)?.capabilitiesOptions || {};
    for (const [cap, title] of Object.entries(titles)) {
      if (!this.hasCapability(cap)) continue;
      const current = this.capabilityOptions(cap);
      if (current?.title?.en === title.en) continue; // already stamped, nothing to do
      this.log(`Setting ${cap} title to '${title.en}' for ${this.getName()} (${this.deviceType})`);
      await this.setCapabilityOptions(cap, { ...(manifestOptions[cap] || {}), title })
        .catch((error) => this.error(error));
    }
  }

  async migrate() {
    try {
      this.log(`checking device migration for ${this.getName()}`);
      let migrated = false;

      // dynamically set capabilityOptions for target_power
      if (this.hasCapability('target_power')) {
        const set = this.getSettings();
        let min = 0;
        let max = 3000;
        if (this.driver.id === 'battery2') {
          min = -(Number(set.maxChargePower || set.nominalPower || 3000));
          max = Number(set.maxDischargePower || set.nominalPower || 3000);
        } else {
          max = Number(set.nominalPower || 3000);
        }
        const opts = this.capabilityOptions('target_power');
        if (opts.min !== min || opts.max !== max) {
          this.log(`Updating target_power options to min: ${min}, max: ${max}`);
          await this.setCapabilityOptions('target_power', { min, max }).catch(this.error);
          migrated = true;
        }
      }

      // store the capability states before migration
      const existingCaps = this.getCapabilities();
      const state = {};
      existingCaps.forEach((cap) => {
        state[cap] = this.getCapabilityValue(cap);
      });
      // check and repair incorrect capability(order)
      const caps = Object.keys(this.capabilityMap() || {});
      let correctCaps = [...caps];
      // remove fake second battery capabilities
      if (this.driver.id === 'battery2') correctCaps = correctCaps.filter((cap) => !cap.includes('.bat2'));
      for (let index = 0; index <= correctCaps.length; index += 1) {
        const caps = this.getCapabilities();
        const newCap = correctCaps[index];
        if (caps[index] !== newCap) {
          migrated = true;
          this.setUnavailable(this.homey.__('status.migrating')).catch(this.error);
          // remove all caps from here
          for (let i = index; i < caps.length; i += 1) {
            this.log(`removing capability ${caps[i]} for ${this.getName()}`);
            await this.removeCapability(caps[i])
              .catch((error) => this.log(error));
            await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
          }
          // add the new cap
          if (newCap !== undefined) {
            this.log(`adding capability ${newCap} for ${this.getName()}`);
            await this.addCapability(newCap);
            // restore capability state
            if (state[newCap]) this.log(`${this.getName()} restoring value ${newCap} to ${state[newCap]}`);
            // else this.log(`${this.getName()} has gotten a new capability ${newCap}!`);
            if (state[newCap] !== undefined) await this.setCapability(newCap, state[newCap]).catch(this.error);
            await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
          }
        }
      }
      // Stamp the AC/DC-correct solar yield titles (see capabilityTitles.js). Runs after the
      // capability repair above so a capability added this pass is titled in the same boot.
      // Titles are cosmetic, so a failure here must never abort the capability migration.
      if (this.driver.id === 'inverter2') {
        await this.syncCapabilityTitles().catch((error) => this.error(error));
      }

      if (migrated) this.restartDevice(1000).catch((error) => this.error(error));
      return migrated;
    } catch (error) {
      this.error(error);
      return false;
    }
  }

  async startPolling(interval = 20) {
    this.homey.clearInterval(this.intervalIdDevicePoll);

    // find non-lastData capabilities
    let capsObj = { ...this.capabilityMap() };
    capsObj = Object.fromEntries(Object.entries(capsObj).filter(([, mapping]) => mapping[0] !== 'getLastData'));
    if (Object.keys(capsObj).length === 0) {
      this.log(`No active polling needed for ${this.getName()} (only lastData capabilities)`);
      return;
    }
    this.log(`start polling ${this.getName()} @${interval} seconds interval`);
    // Jitter initial poll to prevent burst after grouped poll
    await setTimeoutPromise(Math.random() * 5000 + 2000);
    if (this.restarting) return; // abort if restart was triggered during sleep
    await this.doPoll(capsObj);
    if (this.restarting) return; // abort if restart was triggered during poll
    this.homey.clearInterval(this.intervalIdDevicePoll); // clear again just in case
    this.intervalIdDevicePoll = this.homey.setInterval(async () => {
      await this.doPoll(capsObj).catch(this.error);
    }, interval * 1000);
  }

  stopPolling() {
    this.log(`Stop polling ${this.getName()}`);
    this.homey.clearInterval(this.intervalIdDevicePoll);
  }

  async onDeleted() {
    this.stopPolling();
    this.destroyListeners();
    this.log('Device was deleted', this.getName());
  }

  async onUninit() {
    this.log('unInit', this.getName());
    this.stopPolling();
    this.destroyListeners();
    await setTimeoutPromise(2000).catch((error) => this.error(error)); // wait 2 secs
  }

  async onAdded() {
    this.log('added', this.getName());
    // poll lastData once when newly added
    await this.homey.app.getDevices().catch((error) => this.error(error));
    if (!this.growatt) this.growatt = this.homey.app.getSession(this.getSettings());
    await this.pollLastData().catch((error) => this.error(error));
    this.homey.app.everyXminutesHandler().catch((error) => this.error(error));
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed', this.getName(), newSettings);
    if (this.hasCapability('target_power')) {
      if (this.driver.id === 'battery2' && (changedKeys.includes('maxChargePower') || changedKeys.includes('maxDischargePower') || changedKeys.includes('nominalPower'))) {
        const min = -(Number(newSettings.maxChargePower || newSettings.nominalPower || 3000));
        const max = Number(newSettings.maxDischargePower || newSettings.nominalPower || 3000);
        await this.setCapabilityOptions('target_power', { min, max }).catch(this.error);
      } else if (this.driver.id === 'inverter2' && changedKeys.includes('nominalPower')) {
        const min = 0;
        const max = Number(newSettings.nominalPower || 3000);
        await this.setCapabilityOptions('target_power', { min, max }).catch(this.error);
      }
    }
    // nominalPower/maxChargePower/maxDischargePower are already applied live above via
    // setCapabilityOptions (including when fetchDeviceInfo() writes them in the background after
    // boot, see #20e4ea2) - no restart needed for those. Restart only for changes that actually
    // require re-initializing (e.g. username/token/host/deviceSn affecting the API session).
    const powerLimitKeys = ['nominalPower', 'maxChargePower', 'maxDischargePower'];
    const onlyPowerLimitsChanged = changedKeys.length > 0 && changedKeys.every((key) => powerLimitKeys.includes(key));
    if (!onlyPowerLimitsChanged) {
      this.restartDevice(1000).catch((error) => this.error(error));
    }
  }

  async onRenamed(name) {
    this.log('Device was renamed', name);
  }

  async restartDevice(delay) {
    this.stopPolling();
    this.destroyListeners();
    if (this.restarting) return;
    this.restarting = true;
    const dly = delay || 1000 * 5;
    this.log(`Device will restart in ${dly / 1000} seconds`);
    await setTimeoutPromise(dly);
    this.onInit().catch((error) => this.error(error));
  }

  // undefined means "this device does not report this at all" - leave whatever is there alone.
  // null means "there is no value right now" - clear the capability, so a stale reading cannot
  // masquerade as current (measure_efficiency overnight is the case this exists for).
  async setCapability(capability, value) {
    if (!this.hasCapability(capability) || value === undefined || Number.isNaN(value)) return;
    await this.setCapabilityValue(capability, value).catch((error) => {
      this.log(error, capability, value);
    });
  }

  async setSetting(setting, value) {
    const settings = this.getSettings();
    if (value !== undefined && settings && settings[setting] !== value) {
      const newSettings = {};
      newSettings[setting] = value;
      this.log('New setting:', newSettings);
      await this.setSettings(newSettings).catch((error) => {
        this.log(error, setting, value);
      });
    }
  }

  // poll non-lastData capabilities
  async doPoll(capsObj) {
    try {
      if (!capsObj || Object.keys(capsObj).length === 0) return;
      if (this.backoffUntil && Date.now() < this.backoffUntil) return;
      if (this.busy) {
        this.log('still busy. skipping a poll');
        return;
      }
      this.busy = true;
      // Poll the API per capability
      for (const [cap, func] of Object.entries(capsObj)) {
        try {
          if (!func || !func[0]) continue;
          const data = await this.growatt[func[0]]({ deviceSn: this.deviceSn, deviceType: this.deviceType });
          if (data === undefined || data === null) continue;
          // set the capability
          if (func[1]) this.setCapability(cap, func[1](data, this.getSettings())).catch((error) => this.error(error));
        } catch (err) {
          const errMsg = err.message || err;
          // Match on the stable reason code, never on err.message - that text is localized.
          // Unmapped API codes come back as the reason unchanged (see _mapApiError).
          const reason = err.reason || errMsg;
          if (reason === 'zfdyh_Read_failure' || reason === 'READ_DEVICE_PARAM_FAIL' || reason === 'DEVICE_OFFLINE' || reason === 'RATE_LIMITED') {
            this.log(`Error polling ${cap}`, errMsg);
            this.backoffUntil = Date.now() + 5 * 60 * 1000; // Back off for 5 minutes to prevent spam
          } else {
            this.error(`Error polling ${cap}`, errMsg);
          }
        }
      }
      this.busy = false;
    } catch (error) {
      this.busy = false;
      this.error('Poll error', error.message || error);
    }
  }

  // set capabilities based on lastData info
  async handleLastData(data) {
    await this.setAvailable();
    this.lastPoll = Date.now();
    this.permissionDeniedCount = 0;
    if (!this.rawSampleLogged) {
      // one raw sample per restart, so an app diagnostics report captures the actual API
      // fields for this device/deviceType (needed to diagnose mapping gaps, e.g. #8, #17, #19, #21)
      this.rawSampleLogged = true;
      this.log(`Raw lastData sample for ${this.getName()} (${this.driver.id}/${this.deviceType}):`, JSON.stringify(data));
    }
    // map the data to homey capabilities
    let capFuncs = { ...this.capabilityMap() };
    // remove the .bat2 capFuncs when 1st battery, replace capFuncs when 2nd battery
    if (this.driver.id === 'battery2') {
      if (this.getData().id.includes('.bat2')) {
        const batCaps = Object.keys(capFuncs).filter((cap) => cap.includes('.bat2'));
        for (const cap of batCaps) {
          const newCap = cap.replace('.bat2', '');
          capFuncs[newCap] = capFuncs[cap];
        }
      }
      capFuncs = Object.fromEntries(Object.entries(capFuncs).filter(([cap]) => !cap.includes('.bat2')));
    }
    // A hybrid with no battery reports its solar yield on the AC side (see growattMap.js
    // #hasBatteryHistory). The capability VALUES pick that up on their own - the map functions read
    // the same payload - but the titles are stamped state, so re-stamp them whenever the verdict
    // changes. That covers a battery fitted later just as well as one absent from the start: its
    // lifetime counters leave zero the first time it charges, and the next poll relabels the tiles.
    if (this.driver.id === 'inverter2') {
      const hasBattery = growattMap.hasBatteryHistory(data);
      const stored = this.getStoreValue('hasBattery');
      if (hasBattery !== undefined && hasBattery !== stored) {
        await this.setStoreValue('hasBattery', hasBattery).catch((error) => this.error(error));
        // Only an explicit `false` resolves to anything different: growattMap#inverterCapabilities
        // and capabilityTitles#deviceTitles both branch on `=== false` alone, so null/undefined and
        // true give the byte-identical capability set AND the same titles. Restarting for that
        // transition rebuilt nothing while throwing away the payload in hand and leaving every tile
        // blank until the next 5-minute grouped poll - and on a freshly paired hybrid WITH a
        // battery it fires every time, because onAdded()'s single lastData poll is what flips the
        // verdict. That is exactly the "values stay empty after pairing" report. So restart only
        // when the `=== false` side of the verdict actually moves; otherwise fall through and use
        // the payload we already have.
        if ((stored === false) !== (hasBattery === false)) {
          this.log(`Battery history for ${this.getName()} (${this.deviceType}) is now ${hasBattery}; rebuilding capabilities`);
          this.restartDevice(1000).catch((error) => this.error(error));
          return; // migrate() on the way back up rebuilds the capability set and restamps the titles
        }
        this.log(`Battery history for ${this.getName()} (${this.deviceType}) is now ${hasBattery}; capability set and titles unchanged, no restart needed`);
      }
    }
    // compute raw values for all capabilities first, so the '.today' pass below can look up its
    // sibling total capability (e.g. 'meter_power' for 'meter_power.today') regardless of key order
    const computedValues = {};
    for (const [cap, func] of Object.entries(capFuncs)) {
      try {
        if (!func || !func[1]) continue;
        const value = func[1](data, this.getSettings());
        if ((value === undefined || value === null || Number.isNaN(value)) && !this.invalidCapsLogged.has(cap)) {
          // the SN matched but this capability's source field(s) were missing from the payload: likely
          // a field-mapping gap for this deviceType (see #20, #21). Log once per restart with the raw
          // payload so a diagnostics report can pinpoint the actual field name.
          this.invalidCapsLogged.add(cap);
          this.log(`Capability '${cap}' mapped to an invalid value from lastData for ${this.getName()} (${this.driver.id}/${this.deviceType}). Raw data: ${JSON.stringify(data)}`);
        }
        computedValues[cap] = value;
      } catch (err) {
        this.error(`Error mapping capability ${cap} for ${this.getName()}:`, err.message || err);
      }
    }
    // set capabilities
    for (const [cap, value] of Object.entries(computedValues)) {
      const finalValue = cap.endsWith('.today')
        ? this.getTodayEnergy(cap, value, computedValues[cap.replace('.today', '')])
        : value;
      this.setCapability(cap, finalValue).catch((error) => this.error(error));
    }
    // set settings that have changed
    // const newSettings = {
    //   plantName: data.ps_name,
    // };
    // for (const [key, value] of Object.entries(newSettings)) await this.setSetting(key, value);
  }

  // resolve a '.today' capability's value according to the 'dailyEnergyHomeyTimezone' setting.
  // Off (default): trust Growatt's own daily total as-is.
  // On: ignore Growatt's daily total and derive it from the cumulative total capability
  // (rawValue's '.today'-stripped sibling, e.g. 'meter_power' for 'meter_power.today') instead,
  // resetting the baseline at local midnight per Homey's own clock. Some users' dataloggers have a
  // stuck/wrong clock in Growatt's cloud (unfixable without the installer password) that Growatt
  // uses to decide its own daily reset, causing resets at the wrong time of day; this mode sidesteps
  // that entirely since the cumulative total isn't subject to Growatt's day-boundary logic.
  getTodayEnergy(cap, cloudValue, totalValue) {
    if (!this.getSettings().dailyEnergyHomeyTimezone) return cloudValue;
    if (typeof totalValue !== 'number' || Number.isNaN(totalValue)) return cloudValue;

    // A Homey app's Node process runs on UTC, so new Date().getDate() rolls the day over at UTC
    // midnight - 02:00 local in CEST, 01:00 in CET - instead of at the user's own midnight. Resolve
    // the calendar date in Homey's configured timezone instead (same pattern as
    // com.gruijter.powerhour's MeterHelpers.getReadingObject()).
    const now = new Date();
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: this.homey.clock.getTimezone() }));
    const today = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth() + 1).padStart(2, '0')}-${String(nowLocal.getDate()).padStart(2, '0')}`;
    const baselineKey = `todayBaseline_${cap}`;
    const baselineDateKey = `todayBaselineDate_${cap}`;
    let baseline = this.getStoreValue(baselineKey);
    const baselineDate = this.getStoreValue(baselineDateKey);

    if (baselineDate !== today || typeof baseline !== 'number') {
      baseline = totalValue;
      this.setStoreValue(baselineKey, baseline).catch((error) => this.error(error));
      this.setStoreValue(baselineDateKey, today).catch((error) => this.error(error));
    }
    return Math.max(0, totalValue - baseline);
  }

  async handleFlowAction({ action, val }) {
    try {
      const mapFunc = growattMap[`${this.driver.id}Map`]?.[this.deviceType]?.[action]?.[2];
      if (mapFunc) {
        const { call, value } = mapFunc(val, this.getSettings());
        this.log(`Executing flow action '${action}' to '${val}' via API (call: ${call}, mapped value: ${typeof value === 'object' ? JSON.stringify(value) : value})`);
        const doCall = () => this.growatt[call](value);
        await doCall()
          .catch(async (error) => {
            if (error.errorCode === 15 || error.errorCode === 16
              || (error.message && (error.message.includes('PARAMETER_SETTING_DEVICE_NOT_RESPONDING') || error.message.includes('PARAMETER_SETTING_RESPONSE_TIMEOUT')))) {
              this.log('Device not responding, retrying once in 2s...');
              await setTimeoutPromise(2000);
              return doCall();
            }
            throw error;
          })
          .catch((error) => {
            const isSettingError = error.errorCode === 6 || error.errorCode === 14 || error.errorCode === 15 || error.errorCode === 16;
            const isResponseMessageError = error.message && (error.message.includes('PARAMETER_SETTING_FAILED')
            || error.message.includes('WRONG_PARAMETER_VALUE') || error.message.includes('PARAMETER_SETTING_DEVICE_NOT_RESPONDING') || error.message.includes('PARAMETER_SETTING_RESPONSE_TIMEOUT'));
            if (isSettingError || isResponseMessageError) {
              throw new Error(this.homey.__('errors.commandRejectedOrOffline'));
            }
            throw new Error(error.message || error);
          });
        this.backoffUntil = 0; // Resume polling on successful write
        return Promise.resolve(true);
      }
      throw (Error(this.homey.__('errors.actionNotSupported', { action })));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  // special handling for certain device types
  async initSpecials() {
    try {
      // Initialize specific control registers needed for target_power and export limit
      if (this.hasCapability('target_power')) {
        this.log('Setting control authority ON (set_param_1) for', this.getName());
        await this.growatt.setVPP({ deviceSn: this.deviceSn, deviceType: this.deviceType, value: { setType: 'set_param_1', value: '1' } })
          .catch((error) => this.log(`Notice: Control authority (set_param_1) not supported/needed: ${error.message || error}`));
        this.log('Setting dynamic export limitation ON (set_param_13) for', this.getName());
        await this.growatt.setVPP({ deviceSn: this.deviceSn, deviceType: this.deviceType, value: { setType: 'set_param_13', value: '1' } })
          .catch((error) => this.log(`Notice: Dynamic export limit (set_param_13) not supported/needed: ${error.message || error}`));
        if (this.driver.id === 'battery2') {
          this.log('Setting remote power control ON (set_param_25) for', this.getName());
          await this.growatt.setVPP({ deviceSn: this.deviceSn, deviceType: this.deviceType, value: { setType: 'set_param_25', value: '1' } })
            .catch((error) => this.log(`Notice: Remote power control (set_param_25) not supported/needed: ${error.message || error}`));
        }
      }
      return Promise.resolve(true);
    } catch (error) {
      this.error('Failed to init special settings', error);
      return Promise.resolve(true);
    }
  }

  // start listeners
  startListeners() {
    this.destroyListeners();
    this.log('starting listeners', this.getName());
    this.registerCapListeners().catch((error) => this.error(error));
    this.eventListenerLastData = (payload) => {
      if (!payload) return;
      // The emit is global: every device sees every account's poll. A poll that did not ask for
      // this device's SN can say nothing about it - not a match, and not a mismatch worth
      // reporting - so drop it before any of the diagnostics below can fire on it. Without this,
      // two accounts each holding a 'min' device made each device log a "No matching entry" line
      // for the other's poll on every cycle, turning a real field-mapping diagnostic into noise
      // that fires constantly on any healthy multi-account setup.
      //
      // The stale-data watchdog at the bottom deliberately stays outside that filter: it only
      // reads this.lastPoll, so any emit is a fine excuse to re-evaluate it, and gating it on our
      // own account would stop it firing in exactly the case it exists for - our account gone
      // quiet while another one still polls.
      const { lastData, device: polled } = payload;
      const polledSns = typeof polled?.deviceSn === 'string' ? polled.deviceSn.split(',') : null;
      const pollWasForUs = !polledSns || polledSns.includes(this.deviceSn);
      if (!pollWasForUs || !lastData) {
        if ((Date.now() - this.lastPoll) > 61 * 60 * 1000) this.setUnavailable(this.homey.__('status.noUpdates')).catch((error) => this.error(error));
        return;
      }
      const thisDeviceTypeData = lastData[`${this.deviceType}`] || [];
      if (thisDeviceTypeData.length > 0) {
        const device = thisDeviceTypeData.find((device) => (device.serialNum || device.deviceSn || device.inverterId) === this.deviceSn);
        if (device) {
          this.handleLastData(device).catch((error) => this.error(error));
        } else {
          // deviceType had data this cycle, but none of it matched our SN: likely a field-mapping
          // mismatch for this deviceType. Log the received SNs so a diagnostics report can pinpoint it.
          const receivedSns = thisDeviceTypeData.map((d) => d.serialNum || d.deviceSn || d.inverterId);
          this.log(`No matching '${this.deviceType}' entry for SN ${this.deviceSn} in lastData. Received SNs: ${receivedSns.join(', ')}`);
        }
      } else if (!this.emptyDeviceTypeLogged) {
        // lastData carried no entries at all for this deviceType this cycle: distinct from the
        // SN-mismatch case above (see #20) - the API returned nothing to match against in the
        // first place. Log once per restart so a diagnostics report can distinguish the two.
        this.emptyDeviceTypeLogged = true;
        this.log(`No '${this.deviceType}' entries in lastData for ${this.getName()}. Full lastData keys: ${Object.keys(lastData).join(', ')}`);
      }
      if ((Date.now() - this.lastPoll) > 61 * 60 * 1000) this.setUnavailable(this.homey.__('status.noUpdates')).catch((error) => this.error(error));
    };
    this.homey.on('lastData', this.eventListenerLastData);
    this.eventListenerErrorInfo = ({ device, error, reason }) => {
      if (device.deviceSn === this.deviceSn || (typeof device.deviceSn === 'string' && device.deviceSn.split(',').includes(this.deviceSn))) {
        this.error(this.getName(), error);
        const msg = error.message || error;
        // Growatt's API (or the load balancer in front of it) intermittently blips with rate-limit
        // responses, transient HTTP errors (e.g. 503) or network-level failures. These self-resolve
        // on the next poll cycle, so don't flap device availability for them; the watchdog in
        // eventListenerLastData still marks the device unavailable if updates truly stop coming.
        // Match on the stable reason code - the message text is localized. 'fetch failed' is a
        // Node/undici network message that never reaches _mapApiError, so it stays a text match;
        // it is not user-facing copy and is therefore not translated.
        const isTransient = reason === 'RATE_LIMITED' || reason === 'HTTP_ERROR'
          || (typeof msg === 'string' && msg.includes('fetch failed'));
        if (isTransient) return;
        if (reason === 'PERMISSION_DENIED') {
          // tolerate a single blip (seen to self-resolve within minutes); only treat it as a real
          // permission problem once it happens on two consecutive polls in a row
          this.permissionDeniedCount += 1;
          if (this.permissionDeniedCount < 2) return;
        } else {
          this.permissionDeniedCount = 0;
        }
        this.setUnavailable(msg).catch((e) => this.error(e));
      }
    };
    this.homey.on('errorInfo', this.eventListenerErrorInfo);
  }

  // register capability listeners for settable commands
  registerCapListeners() {
    try {
      if (!this.capabilityListeners) this.capabilityListeners = {};
      const capArray = this.getCapabilities();
      capArray.forEach((cap) => {
        const mapFunc = growattMap[`${this.driver.id}Map`]?.[this.deviceType]?.[cap]?.[2];
        if (mapFunc) {
          // capability setting is mapped and present in device
          if (!this.capabilityListeners[cap]) {
            this.log(`${this.getName()} adding capability listener ${cap}`);
            this.registerCapabilityListener(cap, (val) => {
              const { call, value } = mapFunc(val, this.getSettings());
              this.log(`Setting capability '${cap}' to '${val}' via API (call: ${call}, mapped value: ${typeof value === 'object' ? JSON.stringify(value) : value})`);
              return this.growatt[call]({ deviceSn: this.deviceSn, deviceType: this.deviceType, value })
                .catch((error) => {
                  this.error(error);
                  if (error.errorCode === 6 || (error.message && error.message.includes('PARAMETER_SETTING_FAILED'))) {
                    throw new Error(this.homey.__('errors.commandRejected'));
                  }
                  throw error; // rethrow to Homey UI
                });
            });
            this.capabilityListeners[cap] = true;
          }
        }
      });
      return Promise.resolve(true);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  // remove listeners
  destroyListeners() {
    this.log('removing listeners', this.getName());
    if (this.eventListenerLastData) this.homey.removeListener('lastData', this.eventListenerLastData);
    if (this.eventListenerErrorInfo) this.homey.removeListener('errorInfo', this.eventListenerErrorInfo);
  }

};

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
const growattMap = require('./growattMap');
const { deviceTitles } = require('./capabilityTitles');
const DeviceMigrator = require('./DeviceMigrator');
const capture = require('./growattCapture');
const delay = require('./delay');
const growattErrors = require('./growattErrors');
const {
  dateIn, monotonic, raiseListenerCeiling, rebase,
} = require('./deviceHelpers');

// Inverter-powered dataloggers stay silent while the panels are dark, possibly for days under
// snow (not verified), so allow a week before calling the upload stale.
const STALE_AFTER = 7 * 24 * 60 * 60 * 1000;
// An inverter without a battery stops uploading at dusk and the cloud keeps repeating its last
// record. Three missed uploads (cadence ~6 min) on Homey's clock means asleep: its power is 0.
const ASLEEP_AFTER = 20 * 60 * 1000;
// Longer than a night without uploads (polar nights excepted): the datalogger lost its connection.
const CONNECTION_LOST_AFTER = 24 * 60 * 60 * 1000;

module.exports = class MyDevice extends Homey.Device {

  async onInit() {
    try {
      this.restarting = false;
      this.busy = false;
      capture.arm(`device init: ${this.getName()}`);
      this.rawSampleLogged = false; // log one raw API sample per restart, for diagnostics reports
      this.invalidCapsLogged = new Set(); // log each capability's first invalid-value mapping once per restart
      this.emptyDeviceTypeLogged = false; // log once per restart when lastData has no entries for this deviceType
      this.permissionDeniedCount = 0; // consecutive PERMISSION_DENIED polls, reset on success
      this.lastPoll = Date.now(); // the stale-data watchdog starts now
      await this.setAvailable();
      this.deviceType = this.getSettings().deviceType;
      this.deviceSn = this.getSettings().deviceSn;
      this.growatt = this.homey.app.getSession(this.getSettings());
      await this.migrate();
      if (this.restarting) return;
      // await this.initSpecials(); // Initialize required control authorities
      this.startListeners();
      // lastData is polled by app.js
      await this.startPolling();
      // not awaited: API calls are spaced 3 s apart and could push app boot past its timeout
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

  // Store the rated power limits and model from deviceInfo while any of them is missing.
  async fetchDeviceInfo() {
    const initialSettings = this.getSettings();
    const wantsPower = growattMap.usesPowerSettings(this.driver.id);
    // only target_power reads the rated power; a noah's range comes from its model
    const needsPower = this.hasCapability('target_power') && this.deviceType !== 'noah' && !initialSettings.nominalPower;
    const needsFetch = !initialSettings.model || needsPower;
    // at most once a day: a noah's deviceInfo never carries power fields
    const askedAt = Number(this.getStoreValue('deviceInfoAt')) || 0;
    if (needsFetch && (Date.now() - askedAt) < 24 * 60 * 60 * 1000) return;
    if (!needsFetch) return;

    const devInfo = await this.growatt.getDeviceInfo({ deviceSn: this.deviceSn, deviceType: this.deviceType })
      .catch((e) => this.error('Failed to fetch device info', e.message || e));
    await this.setStoreValue('deviceInfoAt', Date.now()).catch((error) => this.error(error));
    if (!devInfo || this.restarting) return;
    const thisDeviceTypeData = devInfo[`${this.deviceType}`] || [];
    const deviceInfo = thisDeviceTypeData.find((d) => growattMap.deviceSnOf(d) === this.deviceSn);
    if (!deviceInfo) {
      this.log('device not found in devInfo', devInfo);
      return;
    }
    this.log(`Raw deviceInfo sample for ${this.getName()} (${this.driver.id}/${this.deviceType}):`, JSON.stringify(deviceInfo));
    const pmax = Number(deviceInfo.pmax || deviceInfo.nominalPower || 0);
    const chargeMax = Number(deviceInfo.maxChargePower || deviceInfo.chargePower || pmax);
    const dischargeMax = Number(deviceInfo.maxDischargePower || deviceInfo.dischargePower || pmax);
    if (!wantsPower) {
      // meter2 has no power settings
    } else if (pmax || chargeMax || dischargeMax) {
      this.log(`Setting nominalPower to ${pmax}, maxChargePower to ${chargeMax}, maxDischargePower to ${dischargeMax}`);
      if (pmax) await this.setSetting('nominalPower', pmax);
      if (chargeMax) await this.setSetting('maxChargePower', chargeMax);
      if (dischargeMax) await this.setSetting('maxDischargePower', dischargeMax);
    } else this.log('power limits not found in deviceInfo', deviceInfo);

    const model = growattMap.deviceModel(deviceInfo, this.deviceSn);
    if (model && model !== initialSettings.model) {
      this.log(`Setting model to '${model}'`);
      await this.setSetting('model', model);
    } else if (!model) this.log('model not found in deviceInfo', deviceInfo);
    // setSettings() does not call onSettings (SDK typings), so apply the new range here
    await DeviceMigrator.syncCapabilityOptions(this, this.capabilityOptions());
  }

  // inverter2 resolves its map from the stored battery verdict, so migrate() and the pollers agree
  capabilityMap() {
    if (this.driver.id !== 'inverter2') return growattMap[`${this.driver.id}Map`][this.deviceType];
    const stored = this.getStoreValue('hasBattery');
    return growattMap.inverterCapabilities(this.deviceType, stored === null ? undefined : stored);
  }

  // Per-device capability options: the target_power range and the inverter2 titles that depend on
  // the device type (capabilityTitles.js).
  capabilityOptions(settings = this.getSettings()) {
    const options = {};
    if (this.hasCapability('target_power')) options.target_power = growattMap.targetPowerOptions(this.driver.id, settings);
    if (this.driver.id === 'inverter2') {
      // null (never polled) means "cannot tell"
      const stored = this.getStoreValue('hasBattery');
      Object.entries(deviceTitles(this.deviceType, stored === null ? undefined : stored)).forEach(([cap, title]) => {
        options[cap] = { ...options[cap], title };
      });
    }
    return options;
  }

  /** Bring the capabilities, their order, the energy object and the capability options in line (lib/DeviceMigrator.js). */
  async migrate() {
    try {
      const correctCaps = Object.keys(this.capabilityMap() || {});
      const changed = await DeviceMigrator.migrateCapabilities(this, correctCaps, {
        shouldAbort: () => this.restarting,
        unavailableMessage: this.homey.__('status.migrating'),
      });
      await DeviceMigrator.migrateEnergy(this);
      // a re-added capability is back on the manifest's options
      await DeviceMigrator.syncCapabilityOptions(this, this.capabilityOptions(), { force: changed });
    } catch (error) {
      this.error(error);
    }
  }

  async startPolling(interval = 20) {
    this.homey.clearInterval(this.intervalIdDevicePoll);

    let capsObj = { ...this.capabilityMap() };
    capsObj = Object.fromEntries(Object.entries(capsObj).filter(([, mapping]) => mapping[0] !== 'getLastData'));
    if (Object.keys(capsObj).length === 0) {
      this.log(`No active polling needed for ${this.getName()} (only lastData capabilities)`);
      return;
    }
    this.log(`start polling ${this.getName()} @${interval} seconds interval`);
    // jitter, so the first polls do not burst after the grouped poll
    await this.delay(Math.random() * 5000 + 2000);
    if (this.restarting) return;
    await this.doPoll(capsObj);
    if (this.restarting) return;
    this.homey.clearInterval(this.intervalIdDevicePoll);
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.intervalIdDevicePoll = this.homey.setInterval(async () => {
      await this.doPoll(capsObj).catch(this.error);
    }, interval * 1000);
  }

  stopPolling() {
    this.log(`Stop polling ${this.getName()}`);
    this.homey.clearInterval(this.intervalIdDevicePoll);
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  async onDeleted() {
    this.stopPolling();
    this.destroyListeners();
    this.log('Device was deleted', this.getName());
  }

  async onUninit() {
    this.log('unInit', this.getName());
    this.stopPolling();
    this.destroyListeners();
    // global timer: whether Homey timers still run during onUninit() is not verified
    await new Promise((resolve) => {
      // eslint-disable-next-line homey-app/global-timers
      setTimeout(resolve, 2000);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  async onAdded() {
    this.log('added', this.getName());
    await this.homey.app.getDevices().catch((error) => this.error(error));
    if (!this.growatt) this.growatt = this.homey.app.getSession(this.getSettings());
    await this.pollLastData().catch((error) => this.error(error));
    this.homey.app.everyXminutesHandler().catch((error) => this.error(error));
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed', this.getName(), newSettings);
    await DeviceMigrator.syncCapabilityOptions(this, this.capabilityOptions(newSettings));
    // power limits and model are applied above; anything else needs a restart
    const noRestartKeys = ['nominalPower', 'maxChargePower', 'maxDischargePower', 'model'];
    const onlyPowerLimitsChanged = changedKeys.length > 0 && changedKeys.every((key) => noRestartKeys.includes(key));
    if (!onlyPowerLimitsChanged) {
      // credentials or type may have changed: the app's schedule follows once we listen again
      this.restartDevice(1000)
        .then(() => this.homey.app.everyXminutesHandler())
        .catch((error) => this.error(error));
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  async onRenamed(name) {
    this.log('Device was renamed', name);
  }

  delay(ms) {
    return delay(this.homey, ms);
  }

  async restartDevice(delay) {
    this.stopPolling();
    this.destroyListeners();
    if (this.restarting) return;
    this.restarting = true;
    const dly = delay || 1000 * 5;
    this.log(`Device will restart in ${dly / 1000} seconds`);
    await this.delay(dly);
    await this.onInit().catch((error) => this.error(error));
  }

  // undefined: not reported, leave the capability alone. null: no value now, clear it.
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

  async doPoll(capsObj) {
    try {
      if (!capsObj || Object.keys(capsObj).length === 0) return;
      if (this.backoffUntil && Date.now() < this.backoffUntil) return;
      if (this.busy) {
        this.log('still busy. skipping a poll');
        return;
      }
      this.busy = true;
      for (const [cap, func] of Object.entries(capsObj)) {
        try {
          if (!func || !func[0]) continue;
          const data = await this.growatt[func[0]]({ deviceSn: this.deviceSn, deviceType: this.deviceType });
          if (data === undefined || data === null) continue;
          if (func[1]) this.setCapability(cap, func[1](data, this.getSettings())).catch((error) => this.error(error));
        } catch (err) {
          const errMsg = err.message || err;
          if (growattErrors.backsOffPolling(err)) {
            this.log(`Error polling ${cap}`, errMsg);
            this.backoffUntil = Date.now() + 5 * 60 * 1000;
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

  async handleLastData(data) {
    this.lastPoll = Date.now();
    this.permissionDeniedCount = 0;
    if (!this.rawSampleLogged) {
      // one raw sample per restart, for diagnostics reports
      this.rawSampleLogged = true;
      this.log(`Raw lastData sample for ${this.getName()} (${this.driver.id}/${this.deviceType}):`, JSON.stringify(data));
    }
    // A datalogger that went offline leaves its last record, all zeros, in the cloud.
    const uploadAt = growattMap.uploadTimeOf(data);
    if (uploadAt && (Date.now() - this.uploadSeenSince(uploadAt)) > STALE_AFTER) {
      const since = typeof data.time === 'string' ? data.time : new Date(uploadAt).toISOString().slice(0, 16).replace('T', ' ');
      if (!this.staleLogged) {
        this.staleLogged = true;
        this.log(`No new data from ${this.getName()} since ${since}; leaving capabilities unchanged`);
      }
      const listedType = await this.listedDeviceType();
      const message = listedType && listedType !== this.deviceType && growattMap[`${this.driver.id}Map`][listedType]
        ? this.homey.__('status.deviceTypeChanged', { type: listedType })
        : this.homey.__('status.staleData', { since });
      this.setUnavailable(message).catch((error) => this.error(error));
      return;
    }
    this.staleLogged = false;
    await this.setAvailable();
    const asleep = this.driver.id === 'inverter2' && !!uploadAt && (Date.now() - this.uploadSeen.heardAt) > ASLEEP_AFTER;
    if (asleep !== !!this.asleep) {
      this.asleep = asleep;
      this.log(asleep ? `No upload from ${this.getName()} for ${ASLEEP_AFTER / 60000} minutes; power set to 0` : `${this.getName()} uploads again`);
    }
    const connectionLost = !!uploadAt && (Date.now() - this.uploadSeen.heardAt) > CONNECTION_LOST_AFTER;
    if (uploadAt && connectionLost !== !!this.connectionLost) {
      this.connectionLost = connectionLost;
      this.log(connectionLost ? `No upload from ${this.getName()} for ${CONNECTION_LOST_AFTER / 3600000} hours: connection alarm` : `${this.getName()} is connected again`);
    }
    const capFuncs = { ...this.capabilityMap() };
    // Store the battery verdict; titles and the capability set follow it.
    if (this.driver.id === 'inverter2') {
      const hasBattery = growattMap.hasBatteryHistory(data);
      const stored = this.getStoreValue('hasBattery');
      if (hasBattery !== undefined && hasBattery !== stored) {
        await this.setStoreValue('hasBattery', hasBattery).catch((error) => this.error(error));
        // only `false` changes the capability set and titles, so only that side warrants a restart
        if ((stored === false) !== (hasBattery === false)) {
          this.log(`Battery history for ${this.getName()} (${this.deviceType}) is now ${hasBattery}; rebuilding capabilities`);
          await this.rebaseSolarYield(data, capFuncs, stored, hasBattery);
          this.restartDevice(1000).catch((error) => this.error(error));
          return; // migrate() rebuilds the capabilities on restart
        }
        this.log(`Battery history for ${this.getName()} (${this.deviceType}) is now ${hasBattery}; capability set and titles unchanged, no restart needed`);
      }
    }
    // all raw values first: a '.today' value may need its total sibling
    const computedValues = {};
    for (const [cap, func] of Object.entries(capFuncs)) {
      try {
        if (!func || !func[1]) continue;
        const value = func[1](data, this.getSettings());
        if ((value === undefined || value === null || Number.isNaN(value)) && !this.invalidCapsLogged.has(cap)) {
          // a field this deviceType does not carry: log once per restart for diagnostics
          this.invalidCapsLogged.add(cap);
          this.log(`Capability '${cap}' mapped to an invalid value from lastData for ${this.getName()} (${this.driver.id}/${this.deviceType}). Raw data: ${JSON.stringify(data)}`);
        }
        computedValues[cap] = asleep && cap.startsWith('measure_power') ? 0 : value;
      } catch (err) {
        this.error(`Error mapping capability ${cap} for ${this.getName()}:`, err.message || err);
      }
    }
    if (uploadAt && capFuncs.alarm_connectivity) computedValues.alarm_connectivity = connectionLost;
    // the new type: an old-type record before the restart must not use it up
    if (this.getStoreValue('rebaseCounters') === this.deviceType) await this.rebaseLifetimeCounters(computedValues);
    await this.holdLifetimeCounters(computedValues, uploadAt);
    for (const [cap, value] of Object.entries(computedValues)) {
      const finalValue = cap.endsWith('.today')
        ? this.getTodayEnergy(cap, value, computedValues[cap.replace('.today', '')])
        : value;
      this.setCapability(cap, finalValue).catch((error) => this.error(error));
    }
  }

  // Lifetime counters never fall, for Homey Energy (deviceHelpers.monotonic). Judged once per
  // upload: the cloud repeats a record until the next, and a repeat must not count as a second fall.
  async holdLifetimeCounters(values, uploadAt) {
    if (!uploadAt) return; // without an upload time a repeat cannot be told from a new record
    // set before any await: a second delivery of this upload meanwhile shares the judgement
    if (this.counted?.uploadAt !== uploadAt) this.counted = { uploadAt, values: this.countLifetime(values) };
    Object.assign(values, await this.counted.values);
  }

  async countLifetime(values) {
    const counted = {};
    for (const [cap, value] of Object.entries(values)) {
      if (!growattMap.isLifetimeCounter(this.driver.id, cap) || !Number.isFinite(value)) continue;
      counted[cap] = await monotonic(this, cap, value).catch((error) => {
        this.error(error);
        return value;
      });
    }
    return counted;
  }

  // After a repair to another type (common_driver.js#onRepair) the counters read other fields: no jump.
  async rebaseLifetimeCounters(values) {
    for (const [cap, value] of Object.entries(values)) {
      if (!growattMap.isLifetimeCounter(this.driver.id, cap) || !Number.isFinite(value)) continue;
      await rebase(this, cap, value).catch((error) => this.error(error));
      this.falling?.delete(cap);
    }
    this.counted = null;
    await this.setStoreValue('rebaseCounters', null).catch((error) => this.error(error));
  }

  // A hybrid's meter_power moves between the AC and DC yield with the battery verdict: continue
  // where it is. The yield since the previous upload is lost, once.
  async rebaseSolarYield(data, oldMap, wasBattery, hasBattery) {
    if (oldMap.meter_power?.[1] !== growattMap.solarYieldTotal) return;
    const before = growattMap.solarYield(data, wasBattery);
    const after = growattMap.solarYield(data, hasBattery);
    if (!Number.isFinite(after) || before === after) return;
    await rebase(this, 'meter_power', after).catch((error) => this.error(error));
  }

  // A '.today' value: Growatt's own, or with 'dailyEnergyHomeyTimezone' on, derived from the total
  // with a reset at Homey's local midnight (some dataloggers' clocks are wrong in Growatt's cloud).
  getTodayEnergy(cap, cloudValue, totalValue) {
    if (!this.getSettings().dailyEnergyHomeyTimezone) return cloudValue;
    if (typeof totalValue !== 'number' || Number.isNaN(totalValue)) return cloudValue;

    // the app runs on UTC, so take the date in Homey's timezone
    const today = dateIn(new Date(), this.homey.clock.getTimezone());
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
    const mapFunc = growattMap[`${this.driver.id}Map`]?.[this.deviceType]?.[action]?.[2];
    if (!mapFunc) throw Error(this.homey.__('errors.actionNotSupported', { action }));
    return this.writeSetting(action, val, mapFunc);
  }

  // A capability or flow write through the API, retried once when the device does not answer in time.
  async writeSetting(name, val, mapFunc) {
    const { call, value } = mapFunc(val, this.getSettings());
    this.log(`Setting '${name}' to '${val}' via API (call: ${call}, mapped value: ${typeof value === 'object' ? JSON.stringify(value) : value})`);
    const doCall = () => this.growatt[call]({ deviceSn: this.deviceSn, deviceType: this.deviceType, value });
    try {
      await doCall().catch(async (error) => {
        if (!growattErrors.isNotResponding(error)) throw error;
        // outside Growatt's 5 s window, inside which an identical control request is refused
        this.log('Device not responding, retrying once in 6s...');
        await this.delay(6000);
        return doCall();
      });
    } catch (error) {
      this.error(error);
      const key = growattErrors.writeErrorKey(error);
      throw new Error(key ? this.homey.__(key) : (error.message || error));
    }
    this.backoffUntil = 0;
    return true;
  }

  async initSpecials() {
    try {
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

  // Since when this upload time has been current, on Homey's clock. Only an upload seen first
  // after (re)start is dated by the payload clock, so a datalogger clock that is days off clears
  // with its next upload. heardAt is always Homey's clock: when this app first saw the upload,
  // kept in the store so a restart does not reset it.
  uploadSeenSince(uploadAt) {
    if (!this.uploadSeen || this.uploadSeen.at !== uploadAt) {
      const heard = this.getStoreValue('uploadHeard');
      const heardAt = !this.uploadSeen && heard?.at === uploadAt && heard.heardAt <= Date.now() ? heard.heardAt : Date.now();
      this.uploadSeen = { at: uploadAt, since: this.uploadSeen ? Date.now() : Math.min(uploadAt, Date.now()), heardAt };
      if (heardAt !== heard?.heardAt) this.setStoreValue('uploadHeard', { at: uploadAt, heardAt }).catch((error) => this.error(error));
    }
    return this.uploadSeen.since;
  }

  // The type Growatt now lists this serial under: a device can move type (inv to min), leaving the
  // old type's last record behind. Asked at most once a day, and only while the data is stale.
  async listedDeviceType() {
    const day = 24 * 60 * 60 * 1000;
    if (this.listedTypeAt && (Date.now() - this.listedTypeAt) < day) return this.listedType;
    this.listedTypeAt = Date.now();
    const list = await this.growatt.getDeviceList2({})
      .then((res) => res?.data)
      .catch((error) => this.error('Failed to fetch device list', error.message || error));
    if (!Array.isArray(list)) {
      this.listedTypeAt = Date.now() - day + (60 * 60 * 1000); // a failed request is retried after an hour
      return undefined;
    }
    this.listedType = growattMap.listedDeviceType(list, this.deviceSn);
    if (this.listedType && this.listedType !== this.deviceType) {
      this.log(`${this.getName()} is listed as '${this.listedType}', paired as '${this.deviceType}'`);
    }
    return this.listedType;
  }

  checkNoUpdates() {
    if ((Date.now() - this.lastPoll) > 61 * 60 * 1000) this.setUnavailable(this.homey.__('status.noUpdates')).catch((error) => this.error(error));
  }

  // Every poll reaches every device. Ours: our serial, and our credentials and type, since a
  // sibling device on the same serial may still poll with old ones after a repair.
  pollIsForUs(polled) {
    if (!polled) return false;
    const sns = typeof polled.deviceSn === 'string' ? polled.deviceSn.split(',') : [];
    if (!sns.includes(this.deviceSn)) return false;
    const { username, token } = this.getSettings();
    if (polled.token !== undefined && (polled.token !== token || polled.username !== username)) return false;
    return polled.deviceType === undefined || polled.deviceType === this.deviceType;
  }

  startListeners() {
    this.destroyListeners();
    this.log('starting listeners', this.getName());
    this.registerCapListeners().catch((error) => this.error(error));
    this.eventListenerLastData = (payload) => {
      if (!payload) return;
      // the watchdog stays outside the filter, so it still fires when only our poll is quiet
      const { lastData, device: polled } = payload;
      if (!this.pollIsForUs(polled) || !lastData) {
        this.checkNoUpdates();
        return;
      }
      const thisDeviceTypeData = lastData[`${this.deviceType}`] || [];
      if (thisDeviceTypeData.length > 0) {
        const device = thisDeviceTypeData.find((d) => growattMap.deviceSnOf(d) === this.deviceSn);
        if (device) {
          this.handleLastData(device).catch((error) => this.error(error));
        } else {
          // data for this deviceType, but not for our SN: log the SNs received
          const receivedSns = thisDeviceTypeData.map((d) => growattMap.deviceSnOf(d));
          this.log(`No matching '${this.deviceType}' entry for SN ${this.deviceSn} in lastData. Received SNs: ${receivedSns.join(', ')}`);
        }
      } else if (!this.emptyDeviceTypeLogged) {
        // no entries at all for this deviceType: log once per restart
        this.emptyDeviceTypeLogged = true;
        this.log(`No '${this.deviceType}' entries in lastData for ${this.getName()}. Full lastData keys: ${Object.keys(lastData).join(', ')}`);
      }
      this.checkNoUpdates();
    };
    // devices initialise before app.js#getDevices runs, so raise Node's limit of ten before adding
    raiseListenerCeiling(this.homey, 'lastData');
    this.homey.on('lastData', this.eventListenerLastData);
    this.eventListenerErrorInfo = ({ device, error, reason }) => {
      if (this.pollIsForUs(device)) {
        this.error(this.getName(), error);
        const msg = error.message || error;
        if (growattErrors.isTransient(reason)) {
          this.checkNoUpdates(); // an outage brings no lastData to run it
          return;
        }
        if (reason === 'PERMISSION_DENIED') {
          // only on two consecutive polls: a single one clears by itself
          this.permissionDeniedCount += 1;
          if (this.permissionDeniedCount < 2) return;
        } else {
          this.permissionDeniedCount = 0;
        }
        this.setUnavailable(msg).catch((e) => this.error(e));
      }
    };
    raiseListenerCeiling(this.homey, 'errorInfo');
    this.homey.on('errorInfo', this.eventListenerErrorInfo);
  }

  registerCapListeners() {
    try {
      if (!this.capabilityListeners) this.capabilityListeners = {};
      const capArray = this.getCapabilities();
      capArray.forEach((cap) => {
        const mapFunc = growattMap[`${this.driver.id}Map`]?.[this.deviceType]?.[cap]?.[2];
        if (mapFunc) {
          if (!this.capabilityListeners[cap]) {
            this.log(`${this.getName()} adding capability listener ${cap}`);
            // the thrown error is shown in the Homey UI
            this.registerCapabilityListener(cap, (val) => this.writeSetting(cap, val, mapFunc));
            this.capabilityListeners[cap] = true;
          }
        }
      });
      return Promise.resolve(true);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  destroyListeners() {
    this.log('removing listeners', this.getName());
    if (this.eventListenerLastData) this.homey.removeListener('lastData', this.eventListenerLastData);
    if (this.eventListenerErrorInfo) this.homey.removeListener('errorInfo', this.eventListenerErrorInfo);
  }

};

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

const setTimeoutPromise = util.promisify(setTimeout);

module.exports = class MyDevice extends Homey.Device {

  async onInit() {
    try {
      this.restarting = false;
      this.busy = false;
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

  async migrate() {
    try {
      this.log(`checking device migration for ${this.getName()}`);
      let migrated = false;

      // Auto-populate nominalPower / maxChargePower / maxDischargePower
      const devInfo = await this.growatt.getDeviceInfo({ deviceSn: this.deviceSn, deviceType: this.deviceType })
        .catch((e) => this.error('Failed to fetch device info', e.message || e));
      if (devInfo) {
        const thisDeviceTypeData = devInfo[`${this.deviceType}`] || [];
        const deviceInfo = thisDeviceTypeData.find((device) => (device.serialNum || device.deviceSn || device.inverterId) === this.deviceSn);
        const pmax = Number(deviceInfo.pmax);
        if (pmax) {
          this.log(' Setting nominalPower/maxChargePower/maxDischargePower to', pmax);
          await this.setSetting('nominalPower', pmax);
          await this.setSetting('maxChargePower', pmax);
          await this.setSetting('maxDischargePower', pmax);
        } else this.log('pmax not found', devInfo);
      }

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
        const opts = this.getCapabilityOptions('target_power');
        if (!opts || opts.min !== min || opts.max !== max) {
          this.log(`Updating target_power options to min: ${min}, max: ${max}`);
          await this.setCapabilityOptions('target_power', { min, max }).catch(this.error);
          migrated = true;
        }
      }

      // store the capability states before migration
      const sym = Object.getOwnPropertySymbols(this).find((s) => String(s) === 'Symbol(state)');
      const state = this[sym];
      // check and repair incorrect capability(order)
      const caps = Object.keys(growattMap[`${this.driver.id}Map`][this.deviceType]);
      let correctCaps = [...caps];
      // remove fake second battery capabilities
      if (this.driver.id === 'battery2') correctCaps = correctCaps.filter((cap) => !cap.includes('.bat2'));
      for (let index = 0; index <= correctCaps.length; index += 1) {
        const caps = this.getCapabilities();
        const newCap = correctCaps[index];
        if (caps[index] !== newCap) {
          migrated = true;
          this.setUnavailable('Migrating. Please wait...').catch(this.error);
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
    let capsObj = { ...growattMap[`${this.driver.id}Map`][this.deviceType] };
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
    this.restartDevice(1000).catch((error) => this.error(error));
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

  async setCapability(capability, value) {
    if (this.hasCapability(capability) && value !== undefined && value !== null && !Number.isNaN(value)) {
      await this.setCapabilityValue(capability, value).catch((error) => {
        this.log(error, capability, value);
      });
    }
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
          if (errMsg === 'zfdyh_Read_failure' || errMsg === 'READ_DEVICE_PARAM_FAIL' || errMsg === 'Too many requests. Wait 5 minutes.') {
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
    // map the data to homey capabilities
    let capFuncs = { ...growattMap[`${this.driver.id}Map`][this.deviceType] };
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
    // set capabilities
    for (const [cap, func] of Object.entries(capFuncs)) {
      try {
        if (!func || !func[1]) continue;
        this.setCapability(cap, func[1](data, this.getSettings())).catch((error) => this.error(error));
      } catch (err) {
        this.error(`Error mapping capability ${cap} for ${this.getName()}:`, err.message || err);
      }
    }
    // set settings that have changed
    // const newSettings = {
    //   plantName: data.ps_name,
    // };
    // for (const [key, value] of Object.entries(newSettings)) await this.setSetting(key, value);
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
              throw new Error('Inverter rejected the command or is not responding. Remote control might be disabled on the inverter hardware, or it is offline.');
            }
            throw new Error(error.message || error);
          });
        this.backoffUntil = 0; // Resume polling on successful write
        return Promise.resolve(true);
      }
      throw (Error(`${action} not supported for this device`));
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
    this.eventListenerLastData = (lastData) => {
      if (!lastData) return;
      const thisDeviceTypeData = lastData[`${this.deviceType}`] || [];
      const device = thisDeviceTypeData.find((device) => (device.serialNum || device.deviceSn || device.inverterId) === this.deviceSn);
      if (device) this.handleLastData(device).catch((error) => this.error(error));
      if ((Date.now() - this.lastPoll) > 61 * 60 * 1000) this.setUnavailable('No updates from device').catch((error) => this.error(error));
    };
    this.homey.on('lastData', this.eventListenerLastData);
    this.eventListenerErrorInfo = ({ device, error }) => {
      if (device.deviceSn === this.deviceSn || (typeof device.deviceSn === 'string' && device.deviceSn.split(',').includes(this.deviceSn))) {
        this.error(this.getName(), error);
        const msg = error.message || error;
        if (msg !== 'Too many requests. Wait 5 minutes.') {
          this.setUnavailable(msg).catch((e) => this.error(e));
        }
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
                    throw new Error('Inverter rejected the command. Remote control might be disabled on the inverter hardware, or a Smart Meter is required.');
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

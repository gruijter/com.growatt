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
      await this.migrate();
      // await this.initSpecials(); // battery charge/discharge trials
      this.startListeners();
      // poll lastData once when (re)started
      await this.pollLastData();
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
    } catch (error) {
      this.error(error);
    }
  }

  async startPolling(interval = 20) {
    // Check if any key in growattMap.nonLastDataMap is included in this.getCapabilities()
    const capabilities = this.getCapabilities();
    const hasMatchingName = Object.keys(growattMap.nonLastDataMap).some((cap) => capabilities.includes(cap));
    if (!hasMatchingName) return; // no need to poll
    this.homey.clearInterval(this.intervalIdDevicePoll);
    this.log(`start polling ${this.getName()} @${interval} seconds interval`);
    await this.doPoll();
    this.intervalIdDevicePoll = this.homey.setInterval(async () => {
      await this.doPoll().catch(this.error);
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
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed', this.getName(), newSettings);
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
    if (this.hasCapability(capability) && value !== undefined && value !== null) {
      await this.setCapabilityValue(capability, value).catch((error) => {
        this.log(error, capability, value);
      });
    }
  }

  setSetting(setting, value) {
    const settings = this.getSettings();
    if (value !== undefined && settings && settings[setting] !== value) {
      const newSettings = {};
      newSettings[setting] = value;
      this.log('New setting:', newSettings);
      this.setSettings(newSettings).catch((error) => {
        this.log(error, setting, value);
      });
    }
  }

  // poll non-lastData capabilities
  async doPoll() {
    try {
      if (this.backoffUntil && Date.now() < this.backoffUntil) {
        return;
      }

      if (this.busy) {
        this.log('still busy. skipping a poll');
        return;
      }
      this.busy = true;
      // Check if any key in growattMap.nonLastDataMap is included in this.getCapabilities()
      const capabilities = this.getCapabilities();
      for (const cap of capabilities) {
        if (growattMap.nonLastDataMap[cap]) {
          // console.log(`Polling ${cap} for ${this.getName()}`);
          try {
            const method = growattMap.nonLastDataMap[cap];
            const data = await this.growatt[method]({ deviceSn: this.deviceSn, deviceType: this.deviceType });
            if (data !== undefined && data !== null) {
              this.setAvailable().catch((error) => this.error(error));
              // map the data to homey capability
              const capFunc = growattMap[`${this.driver.id}Map`][this.deviceType][cap][0];
              const value = capFunc(data);
              this.setCapability(cap, value).catch((error) => this.error(error));
            }
          } catch (error) {
            const errMsg = error.message || error;
            if (errMsg === 'zfdyh_Read_failure' || errMsg === 'READ_DEVICE_PARAM_FAIL') {
              this.log(`Error polling ${cap}`, errMsg);
              this.backoffUntil = Date.now() + 5 * 60 * 1000; // Back off for 5 minutes to prevent spam
            } else {
              this.error(`Error polling ${cap}`, errMsg);
            }
          }
        }
      }
      this.busy = false;
    } catch (error) {
      this.busy = false;
      this.error('Poll error', error.message || error);
    }
  }

  async handleData(data) {
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
    for (const [cap, func] of Object.entries(capFuncs)) this.setCapability(cap, func[0](data)).catch((error) => this.error(error));
    // set settings that have changed
    // const newSettings = {
    //   plantName: data.ps_name,
    // };
    // for (const [key, value] of Object.entries(newSettings)) this.setSetting(key, value);
  }

  async handleFlowAction({ action, val }) {
    try {
      const mapFunc = growattMap[`${this.driver.id}Map`]?.[this.deviceType]?.[action]?.[1];
      if (mapFunc) {
        const { call, value } = mapFunc(val);
        await this.growatt[call]({ deviceSn: this.deviceSn, deviceType: this.deviceType, value });
        this.backoffUntil = 0; // Resume polling on successful write
        return Promise.resolve(true);
      }
      throw (Error(`${action} not supported for this device`));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  // special handling for certain device types
  // async initSpecials() {
  //   try {
  //     // set remote power control ON
  //     if (this.getCapabilities().includes('charge_setpoint')) {
  //       this.log('Setting control authority ON for', this.getName());
  //       await this.growatt.setVPP({ deviceSn: this.deviceSn, deviceType: this.deviceType, value: { setType: 'set_param_1', value: '1' } })
  //         .catch((error) => this.error(error));
  //       this.log('Setting remote power control ON for', this.getName());
  //       await this.growatt.setVPP({ deviceSn: this.deviceSn, deviceType: this.deviceType, value: { setType: 'set_param_25', value: '1' } })
  //         .catch((error) => this.error(error));
  //     }
  //     return Promise.resolve(true);
  //   } catch (error) {
  //     this.error('Failed to init special settings', error);
  //     return Promise.resolve(true);
  //   }
  // }

  // start listeners
  startListeners() {
    this.destroyListeners();
    this.log('starting listeners', this.getName());
    this.registerCapListeners().catch((error) => this.error(error));
    this.eventListenerLastData = (lastData) => {
      if (!lastData) return;
      const thisDeviceTypeData = lastData[`${this.deviceType}`] || [];
      const device = thisDeviceTypeData.find((device) => (device.serialNum || device.deviceSn || device.inverterId) === this.deviceSn);
      if (device) this.handleData(device).catch((error) => this.error(error));
      if ((Date.now() - this.lastPoll) > 61 * 60 * 1000) this.setUnavailable('No updates from device').catch((error) => this.error(error));
    };
    this.homey.on('lastData', this.eventListenerLastData);
    this.eventListenerErrorInfo = ({ device, error }) => {
      if (device.deviceSn === this.deviceSn) {
        this.error(this.getName(), error);
        this.setUnavailable(error.message || error).catch((error) => this.error(error));
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
        const mapFunc = growattMap[`${this.driver.id}Map`]?.[this.deviceType]?.[cap]?.[1];
        if (mapFunc) {
          // capability setting is mapped and present in device
          if (!this.capabilityListeners[cap]) {
            this.log(`${this.getName()} adding capability listener ${cap}`);
            this.registerCapabilityListener(cap, (val) => {
              const { call, value } = mapFunc(val);
              return this.growatt[call]({ deviceSn: this.deviceSn, deviceType: this.deviceType, value })
                .catch((error) => {
                  this.error(error);
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

/*
Copyright 2025, Robin de Gruijter (rmdegruijter@gmail.com)

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
const growattMap = require('./lib/growattMap');

const setTimeoutPromise = util.promisify(setTimeout);

module.exports = class MyDevice extends Homey.Device {

  async onInit() {
    try {
      this.restarting = false;
      this.busy = false;
      await this.setAvailable();
      this.deviceType = this.getSettings().deviceType;
      this.deviceSn = this.getSettings().deviceSn;
      this.startListeners();
      // start polling non-lastData
      await this.startPolling();
      this.log(this.getName(), 'has been initialized');
    } catch (error) {
      const msg = error.message && error.message.includes('"message":') ? JSON.parse(error.message).message : error;
      this.error(error);
      this.setUnavailable(msg).catch(this.error);
      this.restarting = false;
      this.restartDevice(60 * 1000).catch((error) => this.error(error));
    }
  }

  async startPolling(interval = 15) {
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
    await this.homey.app.pollDevice(this.getSettings()).catch((error) => this.error(error));
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
    if (this.hasCapability(capability) && value !== undefined) {
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
          const dev = this.getSettings();
          const data = await this.homey.app[`${growattMap.nonLastDataMap[cap]}`](dev);
          if (data !== undefined && data !== null) {
            this.setAvailable().catch((error) => this.error(error));
            // map the data to homey capability
            const capFunc = growattMap[`${this.driver.id}Map`][this.deviceType][cap][0];
            const value = capFunc(data);
            this.setCapability(cap, value).catch((error) => this.error(error));
          }
        }
      }
      this.busy = false;
    } catch (error) {
      this.busy = false;
      this.error('Poll error', error.message);
    }
  }

  async handleData(data) {
    await this.setAvailable();
    this.lastPoll = Date.now();
    // map the data to homey capabilities
    const capFuncs = growattMap[`${this.driver.id}Map`][this.deviceType];
    for (const [cap, func] of Object.entries(capFuncs)) this.setCapability(cap, func[0](data)).catch((error) => this.error(error));
    // set settings that have changed
    // const newSettings = {
    //   plantName: data.ps_name,
    // };
    // for (const [key, value] of Object.entries(newSettings)) this.setSetting(key, value);
  }

  async handleFlowAction({ action, val }) {
    try {
      const mapFunc = growattMap[`${this.driver.id}Map`][this.deviceType][action][1];
      if (mapFunc) {
        const { call, value } = mapFunc(val);
        await this.homey.app[call](this.getSettings(), value);
        return Promise.resolve(true);
      }
      throw (Error(`${action} not supported for this device`));
    } catch (error) {
      return Promise.reject(error);
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
      const device = thisDeviceTypeData.filter((device) => device.serialNum === this.deviceSn)[0];
      if (device) this.handleData(device).catch((error) => this.error(error));
      if ((Date.now() - this.lastPoll) > 61 * 60 * 1000) this.setUnavailable('No updates from device').catch((error) => this.error(error));
    };
    this.homey.on('lastData', this.eventListenerLastData);
    this.eventListenerErrorInfo = ({ device, error }) => {
      if (device.deviceSn === this.deviceSn) {
        this.error(this.getName(), error);
        const msg = error.message && error.message.includes('"message":') ? JSON.parse(error.message).message : error;
        this.setUnavailable(msg).catch((error) => this.error(error));
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
        const mapFunc = growattMap[`${this.driver.id}Map`][this.deviceType][cap][1];
        if (mapFunc) {
          // capability setting is mapped and present in device
          if (!this.capabilityListeners[cap]) {
            this.log(`${this.getName()} adding capability listener ${cap}`);
            this.registerCapabilityListener(cap, (val) => {
              const { call, value } = mapFunc(val);
              this.homey.app[call](this.getSettings(), value).catch((error) => this.error(error));
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

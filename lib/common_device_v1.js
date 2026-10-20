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
const delay = require('./delay');

module.exports = class MyDevice extends Homey.Device {

  async onInit() {
    try {
      this.restarting = false;
      await this.setAvailable();
      // Check for test V2 device
      const settings = this.getSettings();
      if (settings.token) {
        this.setUnavailable(this.homey.__('status.deprecatedDevice')).catch(this.error);
        return;
      }
      this.startListeners();
      this.homey.app.pollAccountV1(this.getSettings()).catch(this.error);
      this.log(this.getName(), 'v1 has been initialized');
    } catch (error) {
      const msg = error.message && error.message.includes('"msg":') ? JSON.parse(error.message).msg : error;
      this.error(error);
      this.setUnavailable(msg).catch(this.error);
      this.restarting = false;
      this.restartDevice(60 * 1000).catch((error) => this.error(error));
    }
  }

  async onUninit() {
    this.log('unInit', this.getName());
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
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed', this.getName(), newSettings);
    this.restartDevice(1000).catch((error) => this.error(error));
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  async onRenamed(name) {
    this.log('Device was renamed', name);
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  async onDeleted() {
    this.destroyListeners();
    this.log('Device was deleted', this.getName());
  }

  delay(ms) {
    return delay(this.homey, ms);
  }

  async restartDevice(delay) {
    this.destroyListeners();
    if (this.restarting) return;
    this.restarting = true;
    const dly = delay || 1000 * 5;
    this.log(`Device will restart in ${dly / 1000} seconds`);
    await this.delay(dly);
    this.onInit().catch((error) => this.error(error));
  }

  async setCapability(capability, value) {
    if (this.hasCapability(capability) && value !== undefined && value !== null && !Number.isNaN(value)) {
      await this.setCapabilityValue(capability, value).catch((error) => {
        this.log(error, capability, value);
      });
    }
  }

  setSetting(setting, value) {
    const settings = this.getSettings();
    if (settings && settings[setting] !== value) {
      const newSettings = {};
      newSettings[setting] = value;
      this.log('New setting:', newSettings);
      this.setSettings(newSettings).catch((error) => {
        this.log(error, setting, value);
      });
    }
  }

  startListeners() {
    this.destroyListeners();
    this.log('starting listeners', this.getName());
    this.eventListenerPlantInfo = (plantInfo) => {
      // console.log('plantInfo', plantInfo);
      const device = plantInfo.filter((device) => device.deviceData && (this.getData().id.includes(device.deviceData.sn)))[0];
      if (device) this.handleDeviceData(device).catch((error) => this.error(error));
      if ((Date.now() - this.lastPoll) > 61 * 60 * 1000) this.setUnavailable(this.homey.__('status.noUpdates')).catch((error) => this.error(error));
    };
    this.homey.on('plantInfoV1', this.eventListenerPlantInfo);
    this.eventListenerErrorInfo = ({ account, error }) => {
      const { username, password } = this.getSettings();
      if (account.username === username && account.password === password) {
        this.error(this.getName(), error.message || error);
        const msg = error.message && error.message.includes('"msg":') ? JSON.parse(error.message).msg : (error.message || error);
        this.setUnavailable(msg).catch((error) => this.error(error));
      }
    };
    this.homey.on('errorInfoV1', this.eventListenerErrorInfo);
  }

  destroyListeners() {
    this.log('removing listeners', this.getName());
    if (this.eventListenerPlantInfo) this.homey.removeListener('plantInfoV1', this.eventListenerPlantInfo);
    if (this.eventListenerErrorInfo) this.homey.removeListener('errorInfoV1', this.eventListenerErrorInfo);
  }

};

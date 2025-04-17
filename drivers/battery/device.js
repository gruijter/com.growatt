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
const Growatt = require('growatt');

const setTimeoutPromise = util.promisify(setTimeout);

module.exports = class MyDevice extends Homey.Device {

  async onInit() {
    try {
      this.settings = await this.getSettings();
      this.api = new Growatt();
      this.restarting = false;
      this.busy = false;
      await this.setAvailable();
      this.startPolling(this.settings.interval);
      this.log(this.getName(), 'has been initialized');
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
    this.stopPolling();
    await setTimeoutPromise(2000).catch((error) => this.error(error)); // wait 2 secs
  }

  async onAdded() {
    this.log('added', this.getName());
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed', this.getName(), newSettings);
    this.restartDevice(1000).catch((error) => this.error(error));
  }

  async onRenamed(name) {
    this.log('Device was renamed', name);
  }

  async onDeleted() {
    this.stopPolling();
    this.log('Device was deleted', this.getName());
  }

  async restartDevice(delay) {
    // this.destroyListeners();
    if (this.restarting) return;
    this.restarting = true;
    this.stopPolling();
    const dly = delay || 1000 * 5;
    this.log(`Device will restart in ${dly / 1000} seconds`);
    // this.setUnavailable(this.zigbee2MqttType, 'is restarting');
    await setTimeoutPromise(dly);
    this.onInit().catch((error) => this.error(error));
  }

  async setCapability(capability, value) {
    // if (!this.hasCapability(capability)) await this.addCapability(capability).catch((error) => this.error(error));
    if (this.hasCapability(capability) && value !== undefined) {
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

  startPolling(int) {
    const interval = int || 2;
    this.log(`Start polling ${this.getName()} @ ${interval} minute interval`);
    this.stopPolling();
    this.doPoll().catch((error) => this.error(error));
    this.intervalIdDevicePoll = this.homey.setInterval(async () => {
      this.doPoll().catch((error) => this.error(error));
    }, 1000 * 60 * interval);
  }

  stopPolling() {
    this.homey.clearInterval(this.intervalIdDevicePoll);
  }

  async doPoll() {
    try {
      if (this.busy) {
        this.log('skipping a poll');
        return;
      }
      this.busy = true;
      if (!this.api.isConnected()) {
        await this.api.login(this.settings.username, this.settings.password);
        this.log('Logged in', this.getName());
        await this.setAvailable();
      }
      const options = {
        plantId: this.settings.plantId,
        // plantData: false,
        // deviceData: false,
        // deviceTyp: false,
        weather: false,
        // faultlog: false,
        // totalData: false,
        // statusData: false,
        // historyLast: true,
        // historyAll: false,
        // chartLastArray: false,
      };
      const info = await this.api.getAllPlantData(options);
      const plantArray = Object.entries(info).map(([plantId, plantObject]) => ({ ...plantObject }));
      const deviceList = plantArray.flatMap((plant) => Object.entries(plant.devices).map(([deviceName, deviceObject]) => ({ ...deviceObject })));
      const device = deviceList.filter((device) => device.deviceData && (device.deviceData.sn === this.getData().id))[0];
      if (!device) throw Error('Device data not found');
      await this.handleDeviceData(device);
      this.busy = false;
    } catch (error) {
      const msg = error.message && error.message.includes('"msg":') ? JSON.parse(error.message).msg : error;
      this.busy = false;
      this.error(error);
      this.setUnavailable(msg).catch(this.error);
      await this.api.logout();
    }
  }

  async handleDeviceData(device) {
    // check if data is new
    if (!device.historyLast || device.historyLast.createTime === this.lastCreateTime) return;
    this.lastCreateTime = device.historyLast.createTime;
    const values = {
      measure_power: device.historyLast.bdc1ChargePower - device.historyLast.bdc1DischargePower,
      measure_battery: device.historyLast.bdc1Soc,
    };

    // set the capability values
    for (const [capability, value] of Object.entries(values)) {
      this.setCapability(capability, value).catch((error) => this.error(error));
    }
    // set settings that have changed
    const newSettings = {
      // type: device.deviceData.deviceTypeName,
      // model: device.deviceData.deviceModel,
      // serial: device.deviceData.sn,
      // nominalPower: device.deviceData.nominalPower,
      // dataLogger: device.deviceData.datalogSn,
      plantId: device.deviceData.plantId,
      plantName: device.deviceData.plantName,
    };
    for (const [key, value] of Object.entries(newSettings)) this.setSetting(key, value);
  }

};

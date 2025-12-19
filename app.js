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
// const growattMap = require('./lib/growattMap');
const Api = require('./lib/growatt');

module.exports = class MyApp extends Homey.App {

  async onInit() {
    this.devices = {};// { serial: { username, token, serial, type } }; is filled by Homey devices through getSessions
    this.apiSessions = {}; // username__token: apiSession
    this.everyXminutes(5); // start poll emitter
    this.registerFlowListeners(); // register flow listeners
    this.log('Growatt app has been initialized');
  }

  async onUninit() {
    this.log('app onUninit called');
    this.homey.removeAllListeners('lastData');
    this.homey.removeAllListeners('errorInfo');
  }

  everyXminutes(interval) {
    let timeoutId;
    const scheduleNextXminutes = () => {
      if (timeoutId) {
        this.homey.clearTimeout(timeoutId); // Clear any existing timeout
      }
      const now = new Date();
      const nextXminutes = new Date(now);
      const currentMinutes = now.getMinutes();
      const nextMultipleOfX = currentMinutes % interval === 0 ? currentMinutes + interval : Math.ceil(currentMinutes / interval) * interval;
      nextXminutes.setMinutes(nextMultipleOfX, 0, 0);
      const timeToNextXminutes = nextXminutes - now;
      // console.log('everyXminutes starts in', timeToNextXminutes / 1000);
      timeoutId = this.homey.setTimeout(() => {
        this.everyXminutesHandler().catch(this.error);
        scheduleNextXminutes(); // Schedule the next X minutes
      }, timeToNextXminutes);
    };
    scheduleNextXminutes();
    this.log('everyXminutes job started');
  }

  async everyXminutesHandler() {
    await this.getDevices().catch(this.error);
    for (const [, device] of Object.entries(this.devices)) {
      await this.pollDevice(device).catch(this.error);
    }
  }

  getSession(device) {
    const sessionName = `${device.username}__${device.token}`;
    // check if session is connected
    if (!this.apiSessions[sessionName]) {
      this.apiSessions[sessionName] = new Api({ user_name: device.username, token: device.token });
      this.log('New session created for', `${device.username}__${device.token}`);
    }
    return this.apiSessions[sessionName];
  }

  async getDevices() {
    try {
      const inverters = this.homey.drivers.getDriver('inverter2').getDevices();
      const meters = this.homey.drivers.getDriver('meter2').getDevices();
      const batteries = this.homey.drivers.getDriver('battery2').getDevices();
      const devices = [...inverters, ...meters, ...batteries];
      devices.forEach((device) => {
        const {
          username, token, deviceSn, deviceType,
        } = device.getSettings();
        this.devices[`${deviceSn}`] = {
          username, token, deviceSn, deviceType,
        };
      });
      return Promise.resolve(this.devices);
    } catch (error) {
      this.error(error);
      return Promise.reject(error);
    }
  }

  async pollDevice(device) {
    try {
      const session = this.getSession(device);
      const options = { deviceSn: device.deviceSn, deviceType: device.deviceType };
      this.log('Fetching last data for', `${device.username} ${device.deviceSn}, ${device.deviceType}`);
      const lastData = await session.getLastData(options);
      // console.dir(lastData, { depth: null, colors: true });
      this.homey.emit('lastData', lastData); // emit info to devices
      return Promise.resolve(lastData); // return info to driver
    } catch (error) {
      this.homey.emit('errorInfo', { device, error }); // emit error to devices
      return Promise.reject(error); // return info to driver
    }
  }

  async setOnOff(device, value) {
    try {
      const session = this.getSession(device);
      const options = { deviceSn: device.deviceSn, deviceType: device.deviceType, value };
      this.log(`Setting onOff to ${value} for ${device.username} ${device.deviceSn} ${device.deviceType}`);
      const onOff = await session.setOnOff(options);
      return Promise.resolve(onOff);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getActivePower(device) {
    try {
      const session = this.getSession(device);
      const options = { deviceSn: device.deviceSn, deviceType: device.deviceType };
      // this.log(`Getting active power for ${device.username} ${device.deviceSn} ${device.deviceType}`);
      const result = await session.getActivePower(options);
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async setActivePower(device, value) {
    try {
      const session = this.getSession(device);
      const options = { deviceSn: device.deviceSn, deviceType: device.deviceType, value };
      this.log(`Setting active power to ${value} for ${device.username} ${device.deviceSn} ${device.deviceType}`);
      const result = await session.setActivePower(options);
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getChargeSetpoint(device) {
    try {
      const session = this.getSession(device);
      const options = { deviceSn: device.deviceSn, deviceType: device.deviceType };
      // console.log(`Getting charge setpoint for ${device.username} ${device.deviceSn} ${device.deviceType}`);
      const result = await session.getChargeSetpoint(options);
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async setChargeSetpoint(device, value) {
    try {
      const session = this.getSession(device);
      const options = { deviceSn: device.deviceSn, deviceType: device.deviceType, value };
      this.log(`Setting Charge Setpoint power to ${value.value} for ${device.username} ${device.deviceSn} ${device.deviceType}`);
      const result = await session.setChargeSetpoint(options);
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async setVPP(device, value) {
    try {
      const session = this.getSession(device);
      const options = { deviceSn: device.deviceSn, deviceType: device.deviceType, value };
      this.log(`Setting VPP parameter ${value.setType} power to ${value.value} for ${device.username} ${device.deviceSn} ${device.deviceType}`);
      const result = await session.setVPP(options);
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  registerFlowListeners() {
    // custom action cards
    const actionListeners = [];
    const actionList = Homey.manifest.flow.actions;
    actionList.forEach((action, index) => {
      this.log('setting up flow action listener', action.id);
      actionListeners[index] = this.homey.flow.getActionCard(action.id);
      actionListeners[index].registerRunListener(async (args) => {
        try {
          // special case for force poll
          if (action.id === 'force_poll') {
            args.device.log(`Flow action ${action.id} called.`);
            this.everyXminutesHandler().catch(this.error);
            return;
          }
          // all other actions
          args.device.log(`Flow action ${action.id} called with value ${args.val}`);
          await args.device.handleFlowAction({ action: action.id, val: args.val });
        } catch (error) {
          this.error(error);
        }
      });
    });
  }

};

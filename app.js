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
const Growatt = require('growatt'); // v1 API
const Api = require('./lib/growatt_api'); // v2 API

module.exports = class MyApp extends Homey.App {

  async onInit() {
    this.devices = {};// { serial: { username, token, serial, type } }; is filled by Homey devices through getSessions
    this.apiSessions = {}; // username__token: apiSession
    this.everyXminutes(5); // start poll emitter
    this.pendingPolls = {}; // prevents concurrent polling
    this.registerFlowListeners(); // register flow listeners

    // Trigger initial grouped poll 15 seconds after app boot to allow devices to initialize
    this.homey.setTimeout(() => {
      this.log('Performing initial grouped poll');
      this.everyXminutesHandler().catch(this.error);
    }, 15000);

    // DEPRECATED V1
    this.accountsV1 = {}; // { username__passWord: { username, password } }; // is filled by Homey devices
    this.apiSessionsV1 = {}; // username__passWord: apiSession
    this.everyXminutesV1(10); // start poll emitter

    this.log('Growatt app has been initialized');
  }

  async onUninit() {
    this.log('app onUninit called');
    this.homey.removeAllListeners('lastData');
    this.homey.removeAllListeners('errorInfo');

    // DEPRECATED V1
    this.homey.removeAllListeners('plantInfoV1');
    this.homey.removeAllListeners('errorInfoV1');

  }

  // get or create API session, centralized for all drivers and devices
  getSession(device) {
    const username = device.username || '';
    const token = device.token || '';
    const host = device.host || 'openapi.growatt.com';
    const sessionName = `${username}__${token}`;
    // check if session is connected
    if (!this.apiSessions[sessionName]) {
      this.apiSessions[sessionName] = new Api({ user_name: username, token, host });
      this.log('New session created for', `${username}__${token}`, 'on', host);
    } else {
      this.apiSessions[sessionName].host = host; // update host if auto-discovery found a new one
    }
    return this.apiSessions[sessionName];
  }

  // helper to fetch all Homey devices and settings
  async getDevices() {
    try {
      const inverters = this.homey.drivers.getDriver('inverter2').getDevices();
      const meters = this.homey.drivers.getDriver('meter2').getDevices();
      const batteries = this.homey.drivers.getDriver('battery2').getDevices();
      const devices = [...inverters, ...meters, ...batteries];
      this.devices = {}; // Clear old state to prevent polling deleted devices
      devices.forEach((device) => {
        const {
          username, token, host, deviceSn, deviceType,
        } = device.getSettings();
        this.devices[`${deviceSn}`] = {
          username, token, host, deviceSn, deviceType,
        };
      });
      return Promise.resolve(this.devices);
    } catch (error) {
      this.error(error);
      return Promise.reject(error);
    }
  }

  // poll getLastData, centralized for all devices every X minutes
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

    // Group by session and deviceType to query multiple SNs in one API call
    const groups = {};
    for (const device of Object.values(this.devices)) {
      const key = `${device.username}__${device.token}__${device.deviceType}`;
      if (!groups[key]) {
        groups[key] = {
          sessionDevice: device,
          sns: new Set(),
        };
      }
      groups[key].sns.add(device.deviceSn);
    }

    for (const group of Object.values(groups)) {
      const repDevice = { ...group.sessionDevice, deviceSn: Array.from(group.sns).join(',') };
      await this.pollDevice(repDevice).catch(this.error);
      // Small delay between group requests to prevent burst rate limiting
      await new Promise((resolve) => this.homey.setTimeout(resolve, 2000));
    }
  }

  async pollDevice(device) {
    try {
      const cacheKey = `${device.deviceSn}_${device.deviceType}`;
      if (this.pendingPolls[cacheKey]) {
        return await this.pendingPolls[cacheKey];
      }

      const session = this.getSession(device);
      const options = { deviceSn: device.deviceSn, deviceType: device.deviceType };
      this.log('Fetching last data for', `${device.username} ${device.deviceSn}, ${device.deviceType}`);

      const pollPromise = (async () => {
        const lastData = await session.getLastData(options);
        if (lastData) {
          Object.values(lastData).forEach((list) => {
            if (Array.isArray(list)) {
              list.forEach((d) => {
                if (d.serialNum && !d.deviceSn) d.deviceSn = d.serialNum;
                if (d.inverterId && !d.deviceSn) d.deviceSn = d.inverterId;
                if (d.mixSn && !d.deviceSn) d.deviceSn = d.mixSn;
                if (d.spaSn && !d.deviceSn) d.deviceSn = d.spaSn;
                if (d.hpsSn && !d.deviceSn) d.deviceSn = d.hpsSn;
                if (d.tlxSn && !d.deviceSn) d.deviceSn = d.tlxSn;
                if (d.maxSn && !d.deviceSn) d.deviceSn = d.maxSn;
                if (d.pcsSn && !d.deviceSn) d.deviceSn = d.pcsSn;
              });
            }
          });
        }
        this.homey.emit('lastData', lastData); // emit info to devices
        return lastData;
      })();

      this.pendingPolls[cacheKey] = pollPromise;
      const result = await pollPromise;
      delete this.pendingPolls[cacheKey];
      return result;
    } catch (error) {
      const msg = error.message || error;
      this.log('Error fetching last data for', `${device.username} ${device.deviceSn}: ${msg}`);
      const cacheKey = `${device.deviceSn}_${device.deviceType}`;
      delete this.pendingPolls[cacheKey];
      this.homey.emit('errorInfo', { device, error: msg }); // emit error to devices
      return Promise.reject(msg); // return info to driver
    }
  }

  // register flow card listeners
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

            // DEPRECATED V1
            this.everyXminutesHandlerV1().catch(this.error);

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

  // DEPRECATED V1
  everyXminutesV1(interval) {
    let timeoutIdV1;
    const scheduleNextXminutes = () => {
      if (timeoutIdV1) {
        this.homey.clearTimeout(timeoutIdV1); // Clear any existing timeout
      }
      const now = new Date();
      const nextXminutes = new Date(now);
      const currentMinutes = now.getMinutes();
      const nextMultipleOfX = currentMinutes % interval === 0 ? currentMinutes + interval : Math.ceil(currentMinutes / interval) * interval;
      nextXminutes.setMinutes(nextMultipleOfX, 0, 0);
      const timeToNextXminutes = nextXminutes - now;
      // console.log('everyXminutes starts in', timeToNextXminutes / 1000);
      timeoutIdV1 = this.homey.setTimeout(() => {
        this.everyXminutesHandlerV1().catch(this.error);
        scheduleNextXminutes(); // Schedule the next X minutes
      }, timeToNextXminutes);
    };
    scheduleNextXminutes();
    this.log('everyXminutesV1 job started');
  }

  async everyXminutesHandlerV1() {
    await this.getAccountsV1().catch(this.error);
    for (const [key, account] of Object.entries(this.accountsV1)) {
      this.log(`Fetching account data V1: ${key}`);
      await this.pollAccountV1(account).catch(this.error);
    }
  }

  async getAccountsV1() {
    try {
      const inverters = this.homey.drivers.getDriver('inverter').getDevices();
      const batteries = this.homey.drivers.getDriver('battery').getDevices();
      const meters = this.homey.drivers.getDriver('meter').getDevices();
      const devices = [...inverters, ...batteries, ...meters];
      devices.forEach((device) => {
        const { username, password } = device.getSettings();
        this.accountsV1[`${username}__${password}`] = { username, password };
      });
      return Promise.resolve(this.accountsV1);
    } catch (error) {
      this.error(error);
      return Promise.reject(error);
    }
  }

  async pollAccountV1(account) {
    const sessionName = `${account.username}__${account.password}`;
    try {
      // check if session is connected
      if (!this.apiSessionsV1[sessionName]) {
        this.apiSessionsV1[sessionName] = new Growatt();
        this.log('New V1 session created for', `${account.username}__${account.password}`);
      }
      if (!this.apiSessionsV1[sessionName].isConnected()) {
        let result = await this.apiSessionsV1[sessionName].login(account.username, account.password);
        if (!result.result === 1) result = await this.apiSessionsV1[sessionName].login(account.username, account.password); // retry once
        if (!result.result === 1) Error('Login V1 failed');
        this.log('V1 Logged in', `${account.username}__${account.password}`);
      }
      const options = {
        // plantId: plantIdAccount.plantId,
        // plantData: false,
        // deviceData: false,
        // deviceTyp: false,
        weather: false,
        // faultlog: false,
        totalData: false,
        // statusData: false,
        // historyLast: true,
        // historyAll: false,
        // chartLastArray: false,
      };
      let info = await this.apiSessionsV1[sessionName].getAllPlantData(options).catch(() => null);
      if (!info) { // retry once
        this.log(`V1 retrying login ${account.username}__${account.password}`);
        await this.apiSessionsV1[sessionName].login(account.username, account.password);
        info = await this.apiSessionsV1[sessionName].getAllPlantData(options);
      }
      const plantArray = Object.entries(info).map(([plantId, plantObject]) => ({ ...plantObject }));
      const plantInfo = plantArray.flatMap((plant) => Object.entries(plant.devices).map(([deviceName, deviceObject]) => ({ ...deviceObject })));
      this.homey.emit('plantInfoV1', plantInfo); // emit info to devices
      return Promise.resolve(plantInfo); // return info to driver
    } catch (error) {
      // this.error(error);
      this.homey.emit('errorInfoV1', { account, error }); // emit error to devices
      await this.apiSessionsV1[sessionName].logout().catch(this.error);
      return Promise.reject(error); // return info to driver
    }
  }

};

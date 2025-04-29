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
const Growatt = require('growatt');

module.exports = class MyApp extends Homey.App {

  async onInit() {
    this.accounts = {}; // { username__passWord: { username, password } }; // is filled by Homey devices
    this.apiSessions = {}; // username__passWord: apiSession
    this.everyXminutes(15); // start poll emitter
    this.registerFlowListeners(); // register flow listeners
    this.log('Growatt app has been initialized');
  }

  async onUninit() {
    this.log('app onUninit called');
    this.homey.removeAllListeners('plantInfo');
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
    await this.getAccounts().catch(this.error);
    for (const [key, account] of Object.entries(this.accounts)) {
      this.log(`Fetching account data: ${key}`);
      await this.pollAccount(account).catch(this.error);
    }
  }

  async getAccounts() {
    try {
      const inverters = this.homey.drivers.getDriver('inverter').getDevices();
      const batteries = this.homey.drivers.getDriver('battery').getDevices();
      const meters = this.homey.drivers.getDriver('meter').getDevices();
      const devices = [...inverters, ...batteries, ...meters];
      devices.forEach((device) => {
        const { username, password } = device.getSettings();
        this.accounts[`${username}__${password}`] = { username, password };
      });
      return Promise.resolve(this.accounts);
    } catch (error) {
      this.error(error);
      return Promise.reject(error);
    }
  }

  async pollAccount(account) {
    const sessionName = `${account.username}__${account.password}`;
    try {
      // check if session is connected
      if (!this.apiSessions[sessionName]) {
        this.apiSessions[sessionName] = new Growatt();
        this.log('New session created for', `${account.username}__${account.password}`);
      }
      if (!this.apiSessions[sessionName].isConnected()) {
        let result = await this.apiSessions[sessionName].login(account.username, account.password);
        if (!result.result === 1) result = await this.apiSessions[sessionName].login(account.username, account.password); // retry once
        if (!result.result === 1) Error('Login failed');
        this.log('Logged in', `${account.username}__${account.password}`);
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
      let info = await this.apiSessions[sessionName].getAllPlantData(options).catch(this.error);
      if (!info) { // retry once
        this.log(`retrying login ${account.username}__${account.password}`);
        await this.apiSessions[sessionName].login(account.username, account.password);
        info = await this.apiSessions[sessionName].getAllPlantData(options);
      }
      const plantArray = Object.entries(info).map(([plantId, plantObject]) => ({ ...plantObject }));
      const plantInfo = plantArray.flatMap((plant) => Object.entries(plant.devices).map(([deviceName, deviceObject]) => ({ ...deviceObject })));
      this.homey.emit('plantInfo', plantInfo); // emit info to devices
      return Promise.resolve(plantInfo); // return info to driver
    } catch (error) {
      // this.error(error);
      this.homey.emit('errorInfo', { account, error }); // emit error to devices
      await this.apiSessions[sessionName].logout().catch(this.error);
      return Promise.reject(error); // return info to driver
    }
  }

  registerFlowListeners() {
    // action cards
    const forcePoll = this.homey.flow.getActionCard('force_poll');
    forcePoll.registerRunListener((args) => this.everyXminutesHandler(true, 'flow').catch(this.error));
  }

};

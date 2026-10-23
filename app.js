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
const growattMap = require('./lib/growattMap');
const capture = require('./lib/growattCapture');
const timing = require('./lib/growattTiming');

module.exports = class MyApp extends Homey.App {

  async onInit() {
    capture.setLog((line) => this.log(line));
    capture.arm('app start', { force: true });
    this.devices = {}; // pollKey: { username, token, host, deviceSn, deviceType }
    this.apiSessions = {}; // username__token: apiSession
    this.pollSchedules = {}; // pollKey: { timeoutId, cadence, lastUploadAt, lastPollAt }
    this.everyXminutes(5); // reconciles the per-device schedules; the polls themselves are theirs
    this.pendingPolls = {}; // prevents concurrent polling
    this.cooldownNotified = {}; // one log line per rate-limit cooldown, not per skipped poll
    this.registerFlowListeners();

    // remove a settings key no longer used
    try {
      if (this.homey.settings.get('apiRateLimits') !== null) this.homey.settings.unset('apiRateLimits');
    } catch { /* best effort - a leftover key is not worth failing startup over */ }

    // after 15 s, so devices have initialised
    this.bootPollTimeoutId = this.homey.setTimeout(() => {
      this.log('Starting per-device polling');
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
    if (this.pollTimeoutId) {
      this.homey.clearTimeout(this.pollTimeoutId);
    }
    if (this.pollTimeoutIdV1) {
      this.homey.clearTimeout(this.pollTimeoutIdV1);
    }
    if (this.bootPollTimeoutId) {
      this.homey.clearTimeout(this.bootPollTimeoutId);
    }
    Object.values(this.pollSchedules || {}).forEach((schedule) => {
      if (schedule.timeoutId) this.homey.clearTimeout(schedule.timeoutId);
    });
    this.pollSchedules = {};
    this.homey.removeAllListeners('lastData');
    this.homey.removeAllListeners('errorInfo');

    // DEPRECATED V1
    this.homey.removeAllListeners('plantInfoV1');
    this.homey.removeAllListeners('errorInfoV1');

  }

  // one API session per account, shared by all drivers and devices
  getSession(device) {
    const username = device.username || '';
    const token = device.token || '';
    const host = device.host || 'openapi.growatt.com';
    const sessionName = `${username}__${token}`;
    if (!this.apiSessions[sessionName]) {
      this.apiSessions[sessionName] = new Api({
        user_name: username, token, host, homey: this.homey,
      });
      this.log('New session created for', `${username}__${token}`, 'on', host);
    } else {
      this.apiSessions[sessionName].host = host; // discovery may have found another host
    }
    return this.apiSessions[sessionName];
  }

  async getDevices() {
    try {
      const inverters = this.homey.drivers.getDriver('inverter2').getDevices();
      const meters = this.homey.drivers.getDriver('meter2').getDevices();
      const batteries = this.homey.drivers.getDriver('battery2').getDevices()
        .filter((device) => !device.isMergedBattery);
      const devices = [...inverters, ...meters, ...batteries];
      this.devices = {}; // so deleted devices are not polled
      // one entry per distinct poll: devices sharing a serial (inverter2/meter2/battery2) can differ
      // in credentials or type after a repair
      devices.forEach((device) => {
        const {
          username, token, host, deviceSn, deviceType,
        } = device.getSettings();
        const entry = {
          username, token, host, deviceSn, deviceType,
        };
        this.devices[MyApp.pollKey(entry)] = entry;
      });

      return Promise.resolve(this.devices);
    } catch (error) {
      this.error(error);
      return Promise.reject(error);
    }
  }

  // Housekeeping tick: starts and stops per-device schedules; makes no API calls itself.
  everyXminutes(interval) {
    const scheduleNextXminutes = () => {
      if (this.pollTimeoutId) {
        this.homey.clearTimeout(this.pollTimeoutId); // Clear any existing timeout
      }
      const now = new Date();
      const nextXminutes = new Date(now);
      const currentMinutes = now.getMinutes();
      const nextMultipleOfX = currentMinutes % interval === 0 ? currentMinutes + interval : Math.ceil(currentMinutes / interval) * interval;
      nextXminutes.setMinutes(nextMultipleOfX, 0, 0);
      const timeToNextXminutes = nextXminutes - now;
      // console.log('everyXminutes starts in', timeToNextXminutes / 1000);
      this.pollTimeoutId = this.homey.setTimeout(() => {
        this.everyXminutesHandler().catch(this.error);
        scheduleNextXminutes();
      }, timeToNextXminutes);
    };
    scheduleNextXminutes();
    this.log('everyXminutes job started');
  }

  // `force` (force_poll flow card) polls every device now; repeats inside a window come from cache.
  async everyXminutesHandler(force = false) {
    await this.getDevices().catch(this.error);
    this.reconcileSchedules();
    if (!force) return;
    for (const device of Object.values(this.devices)) {
      await this.runDevicePoll(device).catch(this.error);
    }
  }

  // Upload time of this device's entry; without one a device polls at a fixed interval.
  static uploadTimeOf(lastData, deviceSn) {
    if (!lastData) return 0;
    for (const list of Object.values(lastData)) {
      if (!Array.isArray(list)) continue;
      const entry = list.find((e) => e && e.deviceSn === deviceSn);
      if (entry) return growattMap.uploadTimeOf(entry);
    }
    return 0;
  }

  static pollKey(device) {
    return `${device.username}|${device.token}|${device.host}|${device.deviceType}|${device.deviceSn}`;
  }

  reconcileSchedules() {
    Object.keys(this.pollSchedules).forEach((key) => {
      if (this.devices[key]) return;
      const schedule = this.pollSchedules[key];
      if (schedule.timeoutId) this.homey.clearTimeout(schedule.timeoutId);
      delete this.pollSchedules[key];
      this.log('Stopped polling', schedule.label);
    });
    let added = 0;
    Object.entries(this.devices).forEach(([key, device]) => {
      if (this.pollSchedules[key]) return;
      this.pollSchedules[key] = timing.newSchedule(device);
      this.scheduleDevicePoll(device, added * timing.POLL_STAGGER);
      added += 1;
      this.log('Started polling', `${device.deviceSn} (${device.deviceType})`);
    });
  }

  scheduleDevicePoll(device, delay) {
    const schedule = this.pollSchedules[MyApp.pollKey(device)];
    if (!schedule) return;
    if (schedule.timeoutId) this.homey.clearTimeout(schedule.timeoutId);
    schedule.timeoutId = this.homey.setTimeout(() => {
      this.runDevicePoll(device).catch(this.error);
    }, delay);
  }

  // Poll one device, then schedule the next poll just after its next upload.
  async runDevicePoll(device) {
    const key = MyApp.pollKey(device);
    const schedule = this.pollSchedules[key];
    if (!schedule) return;
    schedule.lastPollAt = Date.now();
    const lastData = await this.pollDevice(device).catch(() => null);
    if (this.pollSchedules[key] !== schedule) return; // restarted meanwhile

    const uploadAt = MyApp.uploadTimeOf(lastData, device.deviceSn);
    const target = timing.nextPollAt(schedule, uploadAt, device.deviceType);
    this.scheduleDevicePoll(device, Math.max(1000, target - Date.now()));
  }

  async pollDevice(device) {
    try {
      const cacheKey = MyApp.pollKey(device);
      if (this.pendingPolls[cacheKey]) {
        return await this.pendingPolls[cacheKey];
      }

      const session = this.getSession(device);

      const options = { deviceSn: device.deviceSn, deviceType: device.deviceType };

      // inside this request's window: skip quietly, logged once per cooldown
      const cooldownUntil = session.lastDataCooldownUntil(options);
      if (cooldownUntil) {
        const pollKey = `${device.username}__${device.deviceSn}__${device.deviceType}`;
        if (this.cooldownNotified[pollKey] !== cooldownUntil) {
          this.cooldownNotified[pollKey] = cooldownUntil;
          const secs = Math.ceil((cooldownUntil - Date.now()) / 1000);
          this.log('Rate limited, skipping poll for', `${device.username} ${device.deviceSn} (${device.deviceType})`, `for ${secs}s`);
        }
        return null;
      }

      this.log('Fetching last data for', `${device.username} ${device.deviceSn}, ${device.deviceType}`);

      const pollPromise = (async () => {
        const lastData = await session.getLastData(options);
        if (lastData) {
          Object.values(lastData).forEach((list) => {
            if (Array.isArray(list)) {
              list.forEach((d) => {
                if (!d.deviceSn) d.deviceSn = growattMap.deviceSnOf(d);
              });
            }
          });
        }
        // with the polled device(s), so devices can ignore other accounts' polls
        this.homey.emit('lastData', { lastData, device });
        return lastData;
      })();

      this.pendingPolls[cacheKey] = pollPromise;
      const result = await pollPromise;
      delete this.pendingPolls[cacheKey];
      return result;
    } catch (error) {
      const msg = error.message || error;
      this.log('Error fetching last data for', `${device.username} ${device.deviceSn}: ${msg}`);
      const cacheKey = MyApp.pollKey(device);
      delete this.pendingPolls[cacheKey];
      // listeners match the reason; the message is localized
      this.homey.emit('errorInfo', { device, error: msg, reason: error.reason });
      return Promise.reject(msg); // return info to driver
    }
  }

  registerFlowListeners() {
    const actionListeners = [];
    const actionList = Homey.manifest.flow.actions;
    actionList.forEach((action, index) => {
      this.log('setting up flow action listener', action.id);
      actionListeners[index] = this.homey.flow.getActionCard(action.id);
      actionListeners[index].registerRunListener(async (args) => {
        try {
          // special case for force poll
          if (action.id === 'force_poll') {
            this.log(`Flow action ${action.id} called.`); // an app card: no device argument
            this.everyXminutesHandler(true).catch(this.error);

            // DEPRECATED V1
            this.everyXminutesHandlerV1().catch(this.error);

            return;
          }
          args.device.log(`Flow action ${action.id} called with value ${args.val}`);
          await args.device.handleFlowAction({ action: action.id, val: args.val });
        } catch (error) {
          this.error(error);
          throw error; // the flow card shows it as failed
        }
      });
    });
  }

  // DEPRECATED V1
  everyXminutesV1(interval) {
    const scheduleNextXminutes = () => {
      if (this.pollTimeoutIdV1) {
        this.homey.clearTimeout(this.pollTimeoutIdV1);
      }
      const now = new Date();
      const nextXminutes = new Date(now);
      const currentMinutes = now.getMinutes();
      const nextMultipleOfX = currentMinutes % interval === 0 ? currentMinutes + interval : Math.ceil(currentMinutes / interval) * interval;
      nextXminutes.setMinutes(nextMultipleOfX, 0, 0);
      const timeToNextXminutes = nextXminutes - now;
      // console.log('everyXminutes starts in', timeToNextXminutes / 1000);
      this.pollTimeoutIdV1 = this.homey.setTimeout(() => {
        this.everyXminutesHandlerV1().catch(this.error);
        scheduleNextXminutes();
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

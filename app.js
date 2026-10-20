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

// Cloud data does not arrive on the wall clock. The datalogger uploads on its own free-running
// timer - measured at ~361 s on three separate sites, drifting steadily against real time - while
// Growatt refuses a repeat of the same queryLastData inside the window its docs give for that
// device type (5 minutes; 1 minute for noah). Polling every device on its own clock, phase-locked
// to the upload timestamp the payload itself carries, picks new data up ~POLL_MARGIN after it
// appears instead of up to a full cadence later. See zzz_docs/API-FIELD-NOTES.md sections 10-11.
const POLL_PROFILE = {
  default: { cadence: 361000, minInterval: 305000, bounds: [305000, 420000] },
  noah: { cadence: 61000, minInterval: 61000, bounds: [55000, 130000] },
};
const POLL_MARGIN = 30000; // how long after an expected upload to poll, allowing for jitter
const POLL_STAGGER = 2000; // spread the first poll of each device so no queue forms at boot
const PHASE_STEP = 45000; // how far to nudge the aim when the payload says we mistimed a poll

module.exports = class MyApp extends Homey.App {

  async onInit() {
    capture.setLog((line) => this.log(line));
    capture.arm('app start', { force: true });
    this.devices = {};// { serial: { username, token, serial, type } }; is filled by Homey devices through getSessions
    this.apiSessions = {}; // username__token: apiSession
    this.pollSchedules = {}; // deviceSn: { timeoutId, cadence, lastUploadAt, lastPollAt }
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
      const batteries = this.homey.drivers.getDriver('battery2').getDevices();
      const devices = [...inverters, ...meters, ...batteries];
      this.devices = {}; // so deleted devices are not polled
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

  pollProfile(deviceType) {
    return POLL_PROFILE[deviceType] || POLL_PROFILE.default;
  }

  // Offset of the upload clock from real time. `calendar` is the plant's wall clock parsed in the
  // server's timezone (measured -6 h for a CEST plant), so derive it from a freshly changed upload,
  // rounded to whole quarter-hours like every timezone offset.
  static clockSkew(uploadAt, cadence) {
    return Math.round(((uploadAt - Date.now()) + (cadence / 2)) / 900000) * 900000;
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

  reconcileSchedules() {
    Object.keys(this.pollSchedules).forEach((deviceSn) => {
      if (this.devices[deviceSn]) return;
      const schedule = this.pollSchedules[deviceSn];
      if (schedule.timeoutId) this.homey.clearTimeout(schedule.timeoutId);
      delete this.pollSchedules[deviceSn];
      this.log('Stopped polling', deviceSn);
    });
    let added = 0;
    Object.values(this.devices).forEach((device) => {
      if (this.pollSchedules[device.deviceSn]) return;
      this.pollSchedules[device.deviceSn] = {
        timeoutId: null, cadence: this.pollProfile(device.deviceType).cadence, lastUploadAt: 0, lastPollAt: 0, skew: 0, phase: 0,
      };
      this.scheduleDevicePoll(device, added * POLL_STAGGER);
      added += 1;
      this.log('Started polling', `${device.deviceSn} (${device.deviceType})`);
    });
  }

  scheduleDevicePoll(device, delay) {
    const schedule = this.pollSchedules[device.deviceSn];
    if (!schedule) return;
    if (schedule.timeoutId) this.homey.clearTimeout(schedule.timeoutId);
    schedule.timeoutId = this.homey.setTimeout(() => {
      this.runDevicePoll(device).catch(this.error);
    }, delay);
  }

  // Poll one device, then schedule the next poll just after its next upload.
  async runDevicePoll(device) {
    const schedule = this.pollSchedules[device.deviceSn];
    if (!schedule) return;
    schedule.lastPollAt = Date.now();
    const lastData = await this.pollDevice(device).catch(() => null);

    const uploadAt = MyApp.uploadTimeOf(lastData, device.deviceSn);
    const { minInterval, bounds } = this.pollProfile(device.deviceType);
    if (uploadAt > schedule.lastUploadAt) {
      // cadence from consecutive uploads, smoothed; a gap of two periods counts as a missed upload
      if (schedule.lastUploadAt) {
        const gap = uploadAt - schedule.lastUploadAt;
        const periods = Math.max(1, Math.round(gap / schedule.cadence));
        const observed = gap / periods;
        if (observed >= bounds[0] && observed <= bounds[1]) {
          schedule.cadence = Math.round((schedule.cadence * 0.7) + (observed * 0.3));
        }
        // skipped the upload we aimed at: aimed too late (deliberate k-th-upload skips excluded)
        if (periods > 1 && schedule.aimedPeriods === 1) {
          schedule.phase = Math.max(-schedule.cadence, schedule.phase - PHASE_STEP);
        }
      }
      schedule.lastUploadAt = uploadAt;
      // only on a changed timestamp: stale data would skew it without bound
      schedule.skew = MyApp.clockSkew(uploadAt, schedule.cadence);
    } else if (uploadAt && schedule.lastPollAt) {
      // the same upload twice: aimed too early
      schedule.phase = Math.min(schedule.cadence, schedule.phase + PHASE_STEP);
    }

    // Aim POLL_MARGIN after the first upload due once this request's window has closed (a repeat
    // inside it is refused); that may skip one upload but locks the phase in one cycle.
    const earliest = schedule.lastPollAt + minInterval;
    let target = earliest;
    if (schedule.lastUploadAt) {
      const base = (schedule.lastUploadAt - schedule.skew) + POLL_MARGIN + schedule.phase;
      const periods = Math.max(1, Math.ceil((earliest - base) / schedule.cadence));
      schedule.aimedPeriods = periods; // so a deliberate skip is not later read as a mistimed poll
      target = Math.max(base + (periods * schedule.cadence), earliest);
    }
    this.scheduleDevicePoll(device, Math.max(1000, target - Date.now()));
  }

  async pollDevice(device) {
    try {
      const cacheKey = `${device.deviceSn}_${device.deviceType}`;
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
      const cacheKey = `${device.deviceSn}_${device.deviceType}`;
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
            args.device.log(`Flow action ${action.id} called.`);
            this.everyXminutesHandler(true).catch(this.error);

            // DEPRECATED V1
            this.everyXminutesHandlerV1().catch(this.error);

            return;
          }
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

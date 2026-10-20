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
    this.devices = {};// { serial: { username, token, serial, type } }; is filled by Homey devices through getSessions
    this.apiSessions = {}; // username__token: apiSession
    this.pollSchedules = {}; // deviceSn: { timeoutId, cadence, lastUploadAt, lastPollAt }
    this.everyXminutes(5); // reconciles the per-device schedules; the polls themselves are theirs
    this.pendingPolls = {}; // prevents concurrent polling
    this.cooldownNotified = {}; // one log line per rate-limit cooldown, not per skipped poll
    this.registerFlowListeners(); // register flow listeners

    // The adaptive limiter this replaced kept its learned spacing under `apiRateLimits`. Nothing
    // reads that any more, so upgrading users would carry a dead settings entry forever.
    try {
      if (this.homey.settings.get('apiRateLimits') !== null) this.homey.settings.unset('apiRateLimits');
    } catch { /* best effort - a leftover key is not worth failing startup over */ }

    // Start the per-device schedules 15 seconds after app boot, to let devices initialize first
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

  // get or create API session, centralized for all drivers and devices
  getSession(device) {
    const username = device.username || '';
    const token = device.token || '';
    const host = device.host || 'openapi.growatt.com';
    const sessionName = `${username}__${token}`;
    // check if session is connected
    if (!this.apiSessions[sessionName]) {
      this.apiSessions[sessionName] = new Api({
        user_name: username, token, host, homey: this.homey,
      });
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

  // Housekeeping tick: reconciles the per-device schedules so devices added or removed since the
  // last pass start or stop being polled. It makes no API calls of its own - the polling itself
  // runs on each device's own timer, phase-locked to that datalogger's upload cadence.
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
        scheduleNextXminutes(); // Schedule the next X minutes
      }, timeToNextXminutes);
    };
    scheduleNextXminutes();
    this.log('everyXminutes job started');
  }

  // Reconciliation only - the polls themselves run on each device's own schedule. `force` is for
  // the force_poll flow card, which must poll when the user asks rather than wait for the next
  // slot; a request still inside its window is answered from the client cache, not the network.
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

  // The offset between the upload timestamp and real time. `calendar` is NOT an absolute instant:
  // it is the plant's local wall clock parsed by a server in another timezone, so it sits a fixed
  // whole number of quarter-hours away from now - measured at -6 h for a CEST plant, whose
  // "18:51:35" local came back as 10:51:35Z while the true upload was 16:51:35Z. Rather than
  // assume the server's timezone or the plant's, derive it: an upload timestamp that has just
  // CHANGED cannot be older than the previous poll, so `uploadAt - now` lands within half a
  // cadence of the true offset, and every real timezone offset is a whole number of quarter-hours
  // - so rounding to the nearest quarter-hour recovers it exactly.
  static clockSkew(uploadAt, cadence) {
    return Math.round(((uploadAt - Date.now()) + (cadence / 2)) / 900000) * 900000;
  }

  // When the datalogger uploaded the data just received, on the payload's own clock. `inv` names
  // it timeCalendar, every other device type names it calendar. A device whose payload carries
  // neither has nothing to phase-lock to and simply polls at a fixed interval instead.
  static uploadTimeOf(lastData, deviceSn) {
    if (!lastData) return 0;
    for (const list of Object.values(lastData)) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (!entry || entry.deviceSn !== deviceSn) continue;
        const at = Number(entry.calendar !== undefined ? entry.calendar : entry.timeCalendar);
        return Number.isFinite(at) && at > 0 ? at : 0;
      }
    }
    return 0;
  }

  // Give every device its own schedule, and drop the schedule of any device that no longer exists.
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

  // Poll one device, then work out when its next upload is due and come back just after it.
  async runDevicePoll(device) {
    const schedule = this.pollSchedules[device.deviceSn];
    if (!schedule) return;
    schedule.lastPollAt = Date.now();
    const lastData = await this.pollDevice(device).catch(() => null);

    const uploadAt = MyApp.uploadTimeOf(lastData, device.deviceSn);
    const { minInterval, bounds } = this.pollProfile(device.deviceType);
    if (uploadAt > schedule.lastUploadAt) {
      // Two consecutive uploads measure this datalogger's real cadence. Fold it in gently, and
      // allow for having missed one - a 12-minute gap is two periods, not a 12-minute cadence.
      if (schedule.lastUploadAt) {
        const gap = uploadAt - schedule.lastUploadAt;
        const periods = Math.max(1, Math.round(gap / schedule.cadence));
        const observed = gap / periods;
        if (observed >= bounds[0] && observed <= bounds[1]) {
          schedule.cadence = Math.round((schedule.cadence * 0.7) + (observed * 0.3));
        }
        // Skipping an upload we were AIMING at means we aimed too late. Only when we aimed at the
        // next one: the k-th-upload jump below skips deliberately to lock the phase, and reading
        // that as an error would fight the convergence it is there to produce. Nothing about this
        // judgement needs a correct clock - it is only whether the payload advanced by one period
        // or several - which is what keeps the aim honest on a Homey whose own clock is off.
        if (periods > 1 && schedule.aimedPeriods === 1) {
          schedule.phase = Math.max(-schedule.cadence, schedule.phase - PHASE_STEP);
        }
      }
      schedule.lastUploadAt = uploadAt;
      // Only ever refreshed on a CHANGED timestamp, which is what bounds the estimate: stale data
      // from an offline datalogger would put `uploadAt - now` arbitrarily far out.
      schedule.skew = MyApp.clockSkew(uploadAt, schedule.cadence);
    } else if (uploadAt && schedule.lastPollAt) {
      // The same upload twice: we aimed too early. The other half of the same correction.
      schedule.phase = Math.min(schedule.cadence, schedule.phase + PHASE_STEP);
    }

    // Never before this endpoint's own window is up: a repeat inside it is refused, and retrying
    // cannot help because it would be the identical request. So aim at the first upload that
    // falls due after the window closes - the k-th one, not always the next - and sit POLL_MARGIN
    // behind it. Landing on the k-th costs at most one skipped upload, once, and locks the phase
    // in a single cycle; walking to the next one instead would creep up on it 56 s at a time and
    // take up to seven polls to get there.
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

      // Growatt refuses a repeat of this exact request inside its five-minute window, and the API
      // client refuses it locally rather than earning the trip. Asking anyway would still log a
      // fetch and emit an errorInfo, which is what made a single trip read as two attempts in the
      // log. Skip this poll instead, and say so once per cooldown rather than once per skip. Only
      // this request is held back - other devices on the same account poll normally.
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
        // Pass the polled group along with the payload. The emit is global, so without it every
        // device of this deviceType on EVERY account received this - and each one that did not
        // find its own SN logged a mismatch, once per poll per foreign account. Same {device}
        // contract as the errorInfo emit below, matched on its comma-joined SN list.
        this.homey.emit('lastData', { lastData, device }); // emit info to devices
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
      // pass the stable reason code along - the message text is localized and must never be
      // matched on by the listeners (see common_device.js#startListeners)
      this.homey.emit('errorInfo', { device, error: msg, reason: error.reason }); // emit error to devices
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
            this.everyXminutesHandler(true).catch(this.error);

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
    const scheduleNextXminutes = () => {
      if (this.pollTimeoutIdV1) {
        this.homey.clearTimeout(this.pollTimeoutIdV1); // Clear any existing timeout
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

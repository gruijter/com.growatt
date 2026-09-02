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

// ShinePhone web login: https://openapi.growatt.com/login
// API Docs: https://www.showdoc.com.cn/2598832417617967
// Postman collection: https://www.postman.com/gold-water-163355/growatt-public/overview

'use strict';

const qs = require('node:querystring');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Per-account adaptive rate limiter
//
// Growatt answers FREQUENTLY_ACCESS ("Too many requests. Wait 5 minutes.") far below any
// documented quota - roughly two queryLastData calls for one account inside a minute was enough
// on 2026-09-02. What the limit actually IS has never been established: whether it is keyed on
// the account, the endpoint or both, over what window, is unverified. So nothing below assumes a
// shape. The limiter starts at the spacing this app has always used, widens it whenever the
// server actually complains, and narrows it again once a run of calls has gone through untouched -
// it measures the limit instead of encoding a guess about it.
//
// This replaces a single global 3-second queue that lost on all three counts:
//   - it was global, so unrelated accounts shared one budget, while two calls for the SAME
//     account (the thing the limit is keyed on as far as anything is known) were never spaced
//     wider than 3 s no matter how often that had just failed;
//   - a FREQUENTLY_ACCESS did nothing to the queue, so the next caller fired straight into the
//     server's cooldown and kept it alive - which is why an observed trip stayed tripped for well
//     over the five minutes the message asks for;
//   - nothing outlived the process, so a rebooted app - or the next run of a probing script -
//     started at 3 s again and re-learned the same lesson from scratch. That is what made
//     "space probing calls ~20 s apart" a rule a human had to remember; it is now the limiter's
//     job.
// ---------------------------------------------------------------------------

const MIN_INTERVAL_FLOOR = 3000; // the spacing this app has always used, and the starting point
const MIN_INTERVAL_CEILING = 60000; // never space wider than this, however often it trips
const COOLDOWN_MS = 5 * 60 * 1000; // exactly what the FREQUENTLY_ACCESS message itself asks for
const WIDEN_FACTOR = 2; // on a trip
const NARROW_FACTOR = 1.5; // on a clean run
const NARROW_AFTER_SUCCESSES = 10;
const STORE_KEY = 'apiRateLimits';

// accountKey -> { queue, processing, lastRequestAt, minInterval, cooldownUntil, successes }
const accounts = new Map();

// Persistence, so what one process learned is not thrown away at exit. Inside Homey that is the
// app's own settings; standalone (zzz_test.js, `node -e`) it is a file in the OS temp dir, which
// is what carries the learned spacing from one probing run to the next.
let store = null;
let storeIsHomey = false;
let storeLoaded = false;

function makeHomeyStore(homey) {
  return {
    get() {
      try {
        return homey.settings.get(STORE_KEY) || {};
      } catch (e) {
        return {};
      }
    },
    set(value) {
      try {
        homey.settings.set(STORE_KEY, value);
      } catch (e) { /* best effort - a lost hint is not worth failing a request over */ }
    },
  };
}

function makeFileStore() {
  const file = path.join(os.tmpdir(), 'com.growatt.ratelimits.json');
  return {
    get() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        return {};
      }
    },
    set(value) {
      try {
        fs.writeFileSync(file, JSON.stringify(value));
      } catch (e) { /* best effort */ }
    },
  };
}

function clampInterval(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return MIN_INTERVAL_FLOOR;
  return Math.min(MIN_INTERVAL_CEILING, Math.max(MIN_INTERVAL_FLOOR, Math.round(n)));
}

function accountState(key) {
  let account = accounts.get(key);
  if (!account) {
    account = {
      queue: [],
      processing: false,
      lastRequestAt: 0,
      minInterval: MIN_INTERVAL_FLOOR,
      cooldownUntil: 0,
      successes: 0,
    };
    accounts.set(key, account);
  }
  return account;
}

function persistState() {
  if (!store) return;
  const now = Date.now();
  const value = {};
  for (const [key, account] of accounts) {
    // only worth carrying across a restart if it says something the defaults do not
    if (account.minInterval > MIN_INTERVAL_FLOOR || account.cooldownUntil > now) {
      value[key] = { minInterval: account.minInterval, cooldownUntil: account.cooldownUntil };
    }
  }
  store.set(value);
}

// Called from the constructor, before any request can be enqueued. A Homey reference wins over a
// file store and may arrive second (a client built without one - e.g. inside a test - can come
// first), so upgrading is allowed; downgrading is not. Reading back happens once per store, not
// once per client - discoverHost() alone builds ten of them.
function bindStore(homey) {
  if (storeIsHomey) return;
  if (homey && typeof homey.settings?.get === 'function') {
    store = makeHomeyStore(homey);
    storeIsHomey = true;
    storeLoaded = false;
  } else if (!store) {
    store = makeFileStore();
  }
  if (!store || storeLoaded) return;
  storeLoaded = true;
  const saved = store.get() || {};
  for (const [key, value] of Object.entries(saved)) {
    const account = accountState(key);
    account.minInterval = clampInterval(value?.minInterval);
    account.cooldownUntil = Number(value?.cooldownUntil) || 0;
  }
}

function onRateLimited(account) {
  account.successes = 0;
  account.cooldownUntil = Date.now() + COOLDOWN_MS;
  account.minInterval = clampInterval(account.minInterval * WIDEN_FACTOR);
  persistState();
}

function onSuccess(account) {
  account.successes += 1;
  if (account.successes < NARROW_AFTER_SUCCESSES) return;
  account.successes = 0;
  if (account.minInterval <= MIN_INTERVAL_FLOOR) return;
  account.minInterval = clampInterval(account.minInterval / NARROW_FACTOR);
  persistState();
}

async function processAccount(account) {
  if (account.processing) return;
  account.processing = true;
  while (account.queue.length > 0) {
    const {
      task, resolve, reject, rateLimitedMessage,
    } = account.queue.shift();
    const now = Date.now();
    if (account.cooldownUntil > now) {
      // The server is still counting down, and every call made meanwhile is what keeps it
      // counting. Refuse here instead, with the same reason code a real FREQUENTLY_ACCESS
      // carries, so callers' existing handling (common_device.js#doPoll's 5-minute backoff,
      // #startListeners' transient-error suppression) behaves exactly as it did before.
      const error = Error(rateLimitedMessage);
      error.reason = 'RATE_LIMITED';
      reject(error);
      continue;
    }
    const wait = (account.lastRequestAt + account.minInterval) - now;
    if (wait > 0) {
      // eslint-disable-next-line homey-app/global-timers
      await new Promise((r) => setTimeout(r, wait));
    }
    account.lastRequestAt = Date.now();
    try {
      const result = await task();
      account.lastRequestAt = Date.now();
      onSuccess(account);
      resolve(result);
    } catch (error) {
      account.lastRequestAt = Date.now();
      // branch on the stable reason code, never on the message text - that one is localized
      if (error && error.reason === 'RATE_LIMITED') onRateLimited(account);
      reject(error);
    }
  }
  account.processing = false;
}

function enqueue(accountKey, task, rateLimitedMessage) {
  const account = accountState(accountKey);
  return new Promise((resolve, reject) => {
    account.queue.push({
      task, resolve, reject, rateLimitedMessage,
    });
    // eslint-disable-next-line no-console
    processAccount(account).catch((error) => console.error('Queue processing error:', error));
  });
}

// This module is a plain API client, NOT a Homey.Device/Driver, so it has no this.homey of its
// own and cannot call this.homey.__() directly. Callers pass their own reference in
// (new GrowattClient({ ..., homey: this.homey })) so user-facing errors get localized; without
// one - e.g. under plain `node -e` testing or zzz_test.js - the English fallback is used and the
// class keeps working standalone.
const translate = (homey, key, fallback) => {
  if (!homey || typeof homey.__ !== 'function') return fallback;
  const translated = homey.__(key);
  return translated && translated !== key ? translated : fallback;
};

// API host
const defaultHost = 'openapi.growatt.com';
const defaultPort = 443;
const defaultTimeout = 20000;

// Endpoints
const checkUserEP = '/v1/user/check_user';

const getPlantListEP = '/v1/plant/list';
const getPlantListUserEP = '/v1/plant/user_plant_list';
const getPlantDataEP = '/v1/plant/data';
const getPlantDetailsEP = '/v1/plant/details';
const getDeviceListEP = '/v1/device/list';
const getDeviceList2EP = '/v4/new-api/queryDeviceList';
const getDataLoggerListEP = '/v1/device/datalogger/list';

const getDeviceInfoEP = '/v4/new-api/queryDeviceInfo';
const getLastDataEP = '/v4/new-api/queryLastData';
const getVPPEP = '/v4/new-api/readVppParameter';
const getActivePowerEP = '/v4/new-api/readPower';

const setOnOffEP = '/v4/new-api/setOnOrOff';
const setActivePowerEP = '/v4/new-api/setPower';
const setVPPEP = '/v4/new-api/setVppParameter';

// Represents a session to a growatt system.
class GrowattClient {

  constructor(opts) {
    const options = opts || {};
    this.user_name = options.user_name;
    this.token = options.token;
    // this.password = options.password;
    this.plant_id = options.plant_id;
    this.homey = options.homey; // optional, only used to localize user-facing error messages
    this.host = options.host || defaultHost;
    this.port = defaultPort;
    this.timeout = options.timeout || defaultTimeout;
    this.cookie = undefined;
    this.lastResponse = undefined;
    this.cache = {};
    this.pendingRequests = {};
    bindStore(this.homey);
  }

  _t(key, fallback) {
    return translate(this.homey, key, fallback);
  }

  // The identity the rate limit is keyed on, as far as anything is known: the account, not the
  // host. discoverHost() builds one client per host for the same credentials, and those must
  // share a queue rather than race each other.
  _accountKey() {
    return `${this.user_name || ''}__${this.token || ''}`;
  }

  // When this account's local cooldown expires, as an epoch ms timestamp; 0 when it is free to
  // call. Lets a caller skip a poll cycle outright instead of enqueueing a request that can only
  // come back refused - a refusal it would otherwise log, and emit to devices, exactly as if a
  // real attempt had been made and failed.
  cooldownUntil() {
    const account = accounts.get(this._accountKey());
    if (!account || account.cooldownUntil <= Date.now()) return 0;
    return account.cooldownUntil;
  }

  // eslint-disable-next-line no-console
  static async discoverHost({
    username, token, homey, log = console.log,
  }) {
    const hosts = ['openapi.growatt.com', 'openapi-us.growatt.com', 'openapi-au.growatt.com', 'openapi-cn.growatt.com', 'ess-server.atesspower.com'];
    let lastError;
    let info = false;
    let selectedHost = null;

    for (const host of hosts) {
      const client = new GrowattClient({
        user_name: username, token, host, homey,
      });
      try {
        log(`Trying login on ${host}...`);
        info = await client.getPlantListUser();
        if (info) {
          selectedHost = host;
          log(`Successfully connected to ${host}`);
          break;
        }
      } catch (e) {
        // branch on the stable reason code, never on the message text - that is localized
        if (e.reason === 'RATE_LIMITED') throw e;
        lastError = e;
      }
    }

    if (!info) {
      let userInfo;
      for (const host of hosts) {
        const client = new GrowattClient({
          user_name: username, token, host, homey,
        });
        try {
          userInfo = await client.checkUser();
          if (userInfo && userInfo.userNameExists) {
            selectedHost = host;
            break;
          }
        } catch (e) {}
      }
      let errorMessage = translate(homey, 'errors.apiProblem', 'API problem. Please contact service.nl@growatt.com to fix your account.');
      if (!userInfo || !userInfo.userNameExists) {
        errorMessage = lastError?.message || translate(homey, 'errors.userNotFound', 'User does not exist on any server.');
      }
      throw Error(errorMessage);
    }
    return { host: selectedHost, info };
  }

  async checkUser(opts) {
    const data = {
      user_name: this.user_name,
    };
    if (opts) Object.assign(data, opts);
    try {
      await this._makeRequest(checkUserEP, data);
      return { userNameExists: false };
    } catch (e) {
      if (e.errorCode === 10003) return { userNameExists: true };
      throw e;
    }
  }

  async getPlantList(opts) {
    const queery = {
      // search_type: '',
      // search_keyword: '',
      perPage: 100,
    };
    if (opts) Object.assign(queery, opts);
    const res = await this._makeRequest(`${getPlantListEP}?${qs.stringify(queery)}`);
    return res.data;
  }

  async getPlantListUser(opts) {
    const queery = {
      // search_type: '',
      // search_keyword: '',
      user_name: this.user_name,
      perPage: 100,
    };
    if (opts) Object.assign(queery, opts);
    const res = await this._makeRequest(`${getPlantListUserEP}?${qs.stringify(queery)}`, null);
    return res.data;
  }

  async getPlantData(opts) {
    const queery = {
      plant_id: this.plant_id,
    };
    if (opts) Object.assign(queery, opts);
    const res = await this._makeRequest(`${getPlantDataEP}?${qs.stringify(queery)}`);
    return res.data;
  }

  async getPlantDetails(opts) {
    const queery = {
      plant_id: this.plant_id,
    };
    if (opts) Object.assign(queery, opts);
    const res = await this._makeRequest(`${getPlantDetailsEP}?${qs.stringify(queery)}`);
    return res.data;
  }

  async getDeviceList(opts) {
    const queery = {
      plant_id: this.plant_id,
      perpage: 100,
    };
    if (opts) Object.assign(queery, opts);
    const res = await this._makeRequest(`${getDeviceListEP}?${qs.stringify(queery)}`);
    return res.data;
  }

  async getDeviceList2(opts) {
    const data = {
      page: 1,
    };
    if (opts) Object.assign(data, opts);
    const res = await this._makeRequest(getDeviceList2EP, data);
    return res.data;
  }

  async getDataLoggerList(opts) {
    const queery = {
      plant_id: this.plant_id,
      perpage: 100,
    };
    if (opts) Object.assign(queery, opts);
    const res = await this._makeRequest(`${getDataLoggerListEP}?${qs.stringify(queery)}`);
    return res.data;
  }

  async getDeviceInfo(opts) {
    const data = {
      // deviceSn: 'RDL3CL30A8', // comma seperated list xxxxxxx,xxxxxxx,xxxxxxx
      // deviceType: 'min', // inv, storage, max, sph, spa, min, wit, sph-s, noah
    };
    if (opts) Object.assign(data, opts);
    const res = await this._makeRequest(getDeviceInfoEP, data);
    return res.data;
  }

  async getLastData(opts) {
    const data = {
      // deviceSn: 'RDL3CL30A8', // comma seperated list xxxxxxx,xxxxxxx,xxxxxxx
      // deviceType: 'min', // inv, storage, max, sph, spa, min, wit, sph-s, noah
    };
    if (opts) Object.assign(data, opts);
    const res = await this._makeRequest(getLastDataEP, data);
    return res.data;
  }

  async getVPP(opts) {
    const data = {
      // deviceSn: 'FDCJQ00003',
      // setType: 'set_param_34', // https://www.showdoc.com.cn/p/fc84c86facd79b3692f585fbd7a6e33b
      // deviceType: 'min', // inv, storage, max, sph, spa, min, wit, sph-s, noah",
    };
    if (opts) Object.assign(data, opts);
    const res = await this._makeRequest(getVPPEP, data);
    return res.data;
  }

  async setVPP(opts) {
    const data = {
      deviceSn: opts.deviceSn,
      deviceType: opts.deviceType,
      setType: opts.value?.setType, // https://www.showdoc.com.cn/p/fc84c86facd79b3692f585fbd7a6e33b
      value: opts.value?.value, // value to set
    };
    // if (opts) Object.assign(data, opts);
    const res = await this._makeRequest(setVPPEP, data);
    return res.data;
  }

  async setChargePowerTarget(opts) {
    const data = {};
    if (opts) Object.assign(data, opts);
    data.value = '1';
    data.setType = 'set_param_1'; // control authority enable
    await this._makeRequest(setVPPEP, data);
    data.setType = 'set_param_25'; // remote power control enable
    await this._makeRequest(setVPPEP, data);
    data.setType = 'set_param_26'; // REMOTE POWER CONTROL CHARGING TIME
    data.value = '0'; // indefinite
    await this._makeRequest(setVPPEP, data);
    data.setType = 'set_param_27'; // REMOTE (DIS)CHARGE POWER (discharge -100 ... +100 charge)
    data.value = `${opts.value}`;
    const res = await this._makeRequest(setVPPEP, data);
    return res.data;
  }

  async getChargePowerTarget(opts) {
    const data = {
      // deviceSn: 'FQP0E3D0JR',
      // deviceType: 'min',
      setType: 'set_param_27', //
    };
    if (opts) Object.assign(data, opts);
    const res = await this._makeRequest(getVPPEP, data);
    return res.data;
  }

  async setOnOff(opts) {
    const data = {
      // deviceSn: 'FDCJQ00003',
      // deviceType: 'min', // inv, storage, max, sph, spa, min, wit, sph-s, noah",
      // value: 1, // 0=off, 1=on
    };
    if (opts) Object.assign(data, opts);
    const res = await this._makeRequest(setOnOffEP, data);
    return res.data;
  }

  async setActivePower(opts) {
    const data = {
      // deviceSn: 'FDCJQ00003',
      // deviceType: 'min', // inv, storage, max, sph, spa, min, wit, sph-s, noah",
      // value: ,
    };
    if (opts) Object.assign(data, opts);
    const res = await this._makeRequest(setActivePowerEP, data);
    return res.data;
  }

  async getActivePower(opts) {
    const data = {
      // deviceSn: 'FDCJQ00003',
      // deviceType: 'min', // inv, storage, max, sph, spa, min, wit, sph-s, noah",
    };
    if (opts) Object.assign(data, opts);
    const res = await this._makeRequest(getActivePowerEP, data);
    return res.data;
  }

  // Map a raw API message to a stable reason code plus a localized, user-facing message.
  // Callers MUST branch on the reason code, never on the message text - the text changes with the
  // user's language, which would silently break the rate-limit backoff and the transient-error
  // suppression that used to compare against the English literals.
  _mapApiError(msg) {
    let message = msg;
    if (typeof message === 'string' && message.includes('"message":')) {
      try {
        message = JSON.parse(message).message;
      } catch (e) { /* ignore */ }
    }
    if (message === 'error_permission_denied' || message === 'PERMISSION_DENIED') {
      return { reason: 'PERMISSION_DENIED', message: this._t('errors.permissionDenied', 'Permission denied. Check your API token.') };
    }
    if (typeof message === 'string' && message.toUpperCase().includes('FREQUENTLY_ACCESS')) {
      return { reason: 'RATE_LIMITED', message: this._t('errors.rateLimited', 'Too many requests. Wait 5 minutes.') };
    }
    // unmapped: the raw API code doubles as the reason, so callers can still match on it
    return { reason: message, message };
  }

  async _makeRequest(actionPath, data, timeout, method) {
    let ttl = 5 * 60 * 1000; // 5 minutes
    if (actionPath === getVPPEP || actionPath === getActivePowerEP) {
      ttl = 5 * 1000; // 5 seconds
    }
    if (actionPath === setOnOffEP || actionPath === setActivePowerEP || actionPath === setVPPEP) {
      ttl = 0;
    }

    const cacheKey = `${actionPath}_${JSON.stringify(data)}`;
    const now = Date.now();
    if (ttl > 0 && this.cache[cacheKey] && (now - this.cache[cacheKey].timestamp < ttl)) {
      return this.cache[cacheKey].data;
    }

    if (ttl > 0 && this.pendingRequests[cacheKey]) {
      return this.pendingRequests[cacheKey];
    }

    const requestPromise = (async () => {
      const url = `https://${this.host}:${this.port}${actionPath}`;
      const headers = {
        accept: 'application/json;charset=UTF-8',
        token: this.token,
        Connection: 'keep-alive',
      };
      if (this.cookie) {
        if (Array.isArray(this.cookie)) {
          headers.Cookie = this.cookie.join('; ');
        } else {
          headers.Cookie = this.cookie;
        }
      }

      const options = {
        method: 'GET',
        headers,
      };

      if ((data === null) || (data && data !== '')) {
        options.method = 'POST';
        options.body = data === null ? null : qs.stringify(data);
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }

      if (method) options.method = method;

      // The response is parsed INSIDE the queued task on purpose: FREQUENTLY_ACCESS arrives as a
      // 200 with an error code in the body, so the limiter can only see a trip - and widen its
      // spacing for this account - if the mapping happens before the task returns.
      const jsonRes = await enqueue(this._accountKey(), async () => {
        const controller = new AbortController();
        // eslint-disable-next-line homey-app/global-timers
        const timeoutId = setTimeout(() => controller.abort(), timeout || this.timeout);
        options.signal = controller.signal;
        let status;
        let responseHeaders;
        let body;
        try {
          const response = await fetch(url, options);
          status = response.status;
          responseHeaders = response.headers;
          body = await response.text();
        } finally {
          clearTimeout(timeoutId);
        }

        this.lastResponse = body || status;

        if (status !== 200) {
          // the raw body is untranslatable third-party content - localize only the static prefix
          const err = Error(`${this._t('errors.httpRequestFailed', 'HTTP request failed')}. ${this.lastResponse}`);
          err.reason = 'HTTP_ERROR';
          throw err;
        }

        if (typeof responseHeaders.getSetCookie === 'function') {
          const cookies = responseHeaders.getSetCookie();
          if (cookies && cookies.length > 0) this.cookie = cookies;
        } else {
          const cookie = responseHeaders.get('set-cookie');
          if (cookie) this.cookie = [cookie];
        }

        const contentType = responseHeaders.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          const err = Error(`${this._t('errors.unexpectedResponse', 'Unexpected response from the server')} (${contentType}): ${body}`);
          err.reason = 'BAD_RESPONSE';
          throw err;
        }

        const parsed = JSON.parse(body);
        const errorCode = parsed?.error_code !== undefined ? parsed.error_code : parsed?.code;
        if (errorCode !== 0) {
          const { reason, message } = this._mapApiError(parsed?.error_msg || parsed?.message || body);
          const err = Error(message);
          err.errorCode = errorCode;
          err.reason = reason;
          throw err;
        }
        return parsed;
      }, this._t('errors.rateLimited', 'Too many requests. Wait 5 minutes.'));

      if (ttl > 0) {
        this.cache[cacheKey] = { timestamp: Date.now(), data: jsonRes };
      }
      return jsonRes;
    })();

    if (ttl > 0) {
      this.pendingRequests[cacheKey] = requestPromise;
      requestPromise.finally(() => {
        delete this.pendingRequests[cacheKey];
      }).catch(() => {});
    }

    return requestPromise;
  }

}

module.exports = GrowattClient;

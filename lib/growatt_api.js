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

// API docs: https://www.showdoc.com.cn/2598832417617967

'use strict';

const qs = require('node:querystring');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const capture = require('./growattCapture');

// Growatt rate-limits each exact request (token, endpoint, parameters) for the window its doc page
// states: 5 min for bulk reads, 5 s for control and parameter reads; a repeat earns 10012
// FREQUENTLY_ACCESS, and only that request is refused (verified live). The response cache in
// _makeRequest avoids repeats; the cooldowns here catch what the cache cannot see.

// Spacing between calls to one account, measured live: 250 ms began to earn HTTP 429.
let requestSpacing = 1000;
const WINDOW_LONG = 5 * 60 * 1000; // bulk data reads
const WINDOW_SHORT = 5 * 1000; // control and parameter endpoints
const MAX_COOLDOWNS = 500; // prune threshold; entries expire on their own within WINDOW_LONG

// accountKey -> { queue, processing, lastRequestAt }: one serial queue per account
const accounts = new Map();

// requestKey -> epoch ms before which repeating that exact request would be refused.
const cooldowns = new Map();

// requestKey -> { expiresAt, data } and in-flight promises, shared by every client of an account
// (discoverHost and pairing build their own), keyed like the cooldowns.
const responseCache = new Map();
const pendingRequests = new Map();
const MAX_CACHED = 500;

function pruneCache(now) {
  for (const [key, entry] of responseCache) {
    if (entry.expiresAt <= now) responseCache.delete(key);
  }
}

// Cooldowns and cached responses are persisted together, so after a restart a request inside its
// window is still answered from cache rather than refused.
const STORE_KEY = 'apiRequestState';
const PERSIST_DEBOUNCE_MS = 5000; // one write per burst of calls, not one per call
const MAX_PERSISTED_BYTES = 32 * 1024;
// lastData/deviceInfo (~4 KB per device, rewritten every poll) stay out; the small lists pairing
// needs fit.
const MAX_PERSISTED_ENTRY_BYTES = 3 * 1024;
let store = null;
let storeIsHomey = false;
let storeLoaded = false;
let persistTimer = null;
let storeDisabled = false;

function makeHomeyStore(homey) {
  return {
    get() {
      try {
        return homey.settings.get(STORE_KEY) || {};
      } catch {
        return {};
      }
    },
    set(value) {
      try {
        homey.settings.set(STORE_KEY, value);
      } catch { /* best effort */ }
    },
  };
}

function makeFileStore() {
  const file = path.join(os.tmpdir(), 'com.growatt.requeststate.json');
  return {
    get() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return {};
      }
    },
    set(value) {
      try {
        fs.writeFileSync(file, JSON.stringify(value));
      } catch { /* best effort */ }
    },
  };
}

function writeState() {
  if (!store) return;
  const now = Date.now();
  const value = { cooldowns: {}, cache: {} };
  for (const [key, until] of cooldowns) {
    if (until > now) value.cooldowns[key] = until;
  }
  const live = [];
  for (const [key, entry] of responseCache) {
    if (entry.expiresAt <= now) continue;
    const size = JSON.stringify(entry.data).length;
    if (size <= MAX_PERSISTED_ENTRY_BYTES) live.push([key, entry, size]);
  }
  // smallest first, so the budget drops bulky payloads before the lists pairing needs
  live.sort((a, b) => a[2] - b[2]);
  let budget = MAX_PERSISTED_BYTES;
  for (const [key, entry, size] of live) {
    if (size > budget) break;
    budget -= size;
    value.cache[key] = { expiresAt: entry.expiresAt, data: entry.data };
  }
  store.set(value);
}

function persistState() {
  if (storeDisabled || !store || persistTimer) return;
  // eslint-disable-next-line homey-app/global-timers
  persistTimer = setTimeout(() => {
    persistTimer = null; writeState();
  }, PERSIST_DEBOUNCE_MS);
  if (typeof persistTimer.unref === 'function') persistTimer.unref();
}

// A Homey store replaces a file store (tests), never the other way round; read once per store.
function bindStore(homey) {
  if (storeDisabled || storeIsHomey) return;
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
  const now = Date.now();
  for (const [key, until] of Object.entries(saved.cooldowns || {})) {
    if (Number(until) > now) cooldowns.set(key, Number(until));
  }
  for (const [key, entry] of Object.entries(saved.cache || {})) {
    if (entry && Number(entry.expiresAt) > now) {
      responseCache.set(key, { expiresAt: Number(entry.expiresAt), data: entry.data });
    }
  }
}

// parameter order must not change the key
function stableParams(data) {
  if (!data || typeof data !== 'object') return JSON.stringify(data);
  return JSON.stringify(data, Object.keys(data).sort());
}

function accountState(key) {
  let account = accounts.get(key);
  if (!account) {
    account = { queue: [], processing: false, lastRequestAt: 0 };
    accounts.set(key, account);
  }
  return account;
}

function noteRequest(requestKey, window) {
  const now = Date.now();
  cooldowns.set(requestKey, now + window);
  persistState();
  if (cooldowns.size <= MAX_COOLDOWNS) return;
  for (const [key, until] of cooldowns) {
    if (until <= now) cooldowns.delete(key);
  }
}

async function processAccount(account) {
  if (account.processing) return;
  account.processing = true;
  while (account.queue.length > 0) {
    const {
      task, resolve, reject, requestKey, window, rateLimitedMessage,
    } = account.queue.shift();
    const now = Date.now();
    if ((cooldowns.get(requestKey) || 0) > now) {
      // inside its window: refuse locally with the reason a server trip would carry
      const error = Error(rateLimitedMessage);
      error.reason = 'RATE_LIMITED';
      reject(error);
      continue;
    }
    const wait = (account.lastRequestAt + requestSpacing) - now;
    if (wait > 0) {
      await new Promise((r) => {
        // eslint-disable-next-line homey-app/global-timers
        setTimeout(r, wait);
      });
    }
    account.lastRequestAt = Date.now();
    try {
      const result = await task();
      account.lastRequestAt = Date.now();
      noteRequest(requestKey, window);
      resolve(result);
    } catch (error) {
      account.lastRequestAt = Date.now();
      // match the reason code; the message is localized
      if (error && error.reason === 'RATE_LIMITED') noteRequest(requestKey, window);
      reject(error);
    }
  }
  account.processing = false;
}

function enqueue({
  accountKey, requestKey, window, task, rateLimitedMessage,
}) {
  const account = accountState(accountKey);
  return new Promise((resolve, reject) => {
    account.queue.push({
      task, resolve, reject, requestKey, window, rateLimitedMessage,
    });
    // eslint-disable-next-line no-console
    processAccount(account).catch((error) => console.error('Queue processing error:', error));
  });
}

// Localized when a client was given `homey`, English otherwise (standalone use)
const translate = (homey, key, fallback) => {
  if (!homey || typeof homey.__ !== 'function') return fallback;
  const translated = homey.__(key);
  return translated && translated !== key ? translated : fallback;
};

const defaultHost = 'openapi.growatt.com';
const defaultPort = 443;
const defaultTimeout = 20000;
// shorter, so a dead host cannot hold up discovery past the pairing dialog's timeout
const DISCOVERY_TIMEOUT = 8000;

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
    bindStore(this.homey);
  }

  _t(key, fallback) {
    return translate(this.homey, key, fallback);
  }

  // the queue is per account, not per host: discoverHost() clients must not race
  _accountKey() {
    return `${this.user_name || ''}__${this.token || ''}`;
  }

  // account + endpoint + parameters, plus the host: regional servers are separate backends
  _requestKey(actionPath, data) {
    return `${this._accountKey()}__${this.host}__${actionPath}_${stableParams(data)}`;
  }

  // epoch ms until this exact request may be repeated; 0 when it is free
  cooldownUntil(actionPath, data) {
    const until = cooldowns.get(this._requestKey(actionPath, data)) || 0;
    return until > Date.now() ? until : 0;
  }

  // a device's own lastData cooldown; 0 while a cached answer exists
  lastDataCooldownUntil(opts) {
    const key = this._requestKey(getLastDataEP, { ...opts });
    const cached = responseCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return 0;
    const until = cooldowns.get(key) || 0;
    return until > Date.now() ? until : 0;
  }

  static async discoverHost({
    username, token, homey, log = console.log, // eslint-disable-line no-console
  }) {
    const hosts = ['openapi.growatt.com', 'openapi-us.growatt.com', 'openapi-au.growatt.com', 'openapi-cn.growatt.com', 'ess-server.atesspower.com'];

    // in parallel with a short timeout, so a wrong token fails within the pairing dialog's 30 s
    const probe = async (host, call) => {
      const client = new GrowattClient({
        user_name: username, token, host, homey, timeout: DISCOVERY_TIMEOUT,
      });
      try {
        return { host, result: await call(client) };
      } catch (e) {
        return { host, error: e };
      }
    };

    // the main host alone first: getPlantListUser allows ten calls per day (doc 2.4)
    log(`Trying login on ${hosts[0]}...`);
    const first = await probe(hosts[0], (c) => c.getPlantListUser());
    if (first.result) {
      log(`Successfully connected to ${hosts[0]}`);
      return { host: hosts[0], info: first.result };
    }
    if (first.error && first.error.reason === 'RATE_LIMITED') throw first.error;

    log(`  ${hosts[0]} rejected: ${first.error?.reason || 'unknown'}; trying the other ${hosts.length - 1} servers...`);
    const attempts = [first, ...await Promise.all(hosts.slice(1).map((host) => probe(host, (c) => c.getPlantListUser())))];
    const errors = new Map(attempts.filter((a) => a.error).map((a) => [a.host, a.error]));
    attempts.filter((a) => a.error).forEach(({ host, error }) => {
      log(`  ${host} rejected: ${error.reason || 'unknown'}${error.errorCode !== undefined ? ` (code ${error.errorCode})` : ''}`);
    });

    // host order is a preference, not first-to-answer
    const winner = hosts.map((h) => attempts.find((a) => a.host === h)).find((a) => a && a.result);
    if (winner) {
      log(`Successfully connected to ${winner.host}`);
      return { host: winner.host, info: winner.result };
    }

    // rate limited means the host was right; it clears by itself
    const rateLimited = hosts.map((h) => errors.get(h)).find((e) => e && e.reason === 'RATE_LIMITED');
    if (rateLimited) throw rateLimited;

    // report the failure of the host the user exists on, not of the last host tried
    const checks = await Promise.all(hosts.map((host) => probe(host, (c) => c.checkUser())));
    const known = hosts
      .map((h) => checks.find((c) => c.host === h))
      .find((c) => c && c.result && c.result.userNameExists);

    if (!known) {
      const anyError = hosts.map((h) => errors.get(h)).find((e) => e && e.reason !== 'error_userNotExist');
      throw Error(anyError?.message || translate(homey, 'errors.userNotFound', 'User does not exist on any server.'));
    }

    const relevant = errors.get(known.host);
    log(`Account exists on ${known.host}; it refused with: ${relevant?.reason || 'unknown'}`);
    // the token works but is not assigned to this account: only Growatt can fix that
    if (!relevant || relevant.reason === 'PERMISSION_DENIED') {
      throw Error(translate(homey, 'errors.apiProblem', 'API problem. Please contact service.nl@growatt.com to fix your account.'));
    }
    throw Error(relevant.message);
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
      // deviceSn: 'XXXXXXXXXX', // comma seperated list xxxxxxx,xxxxxxx,xxxxxxx
      // deviceType: 'min', // inv, storage, max, sph, spa, min, wit, sph-s, noah
    };
    if (opts) Object.assign(data, opts);
    const res = await this._makeRequest(getDeviceInfoEP, data);
    return res.data;
  }

  async getLastData(opts) {
    const data = {
      // deviceSn: 'XXXXXXXXXX', // comma seperated list xxxxxxx,xxxxxxx,xxxxxxx
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
      // deviceSn: 'XXXXXXXXXX',
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

  // A raw API message as a stable reason code plus a localized message; callers match the reason.
  _mapApiError(msg) {
    let message = msg;
    if (typeof message === 'string' && message.includes('"message":')) {
      try {
        message = JSON.parse(message).message;
      } catch { /* ignore */ }
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
    const shortWindow = actionPath === getVPPEP || actionPath === getActivePowerEP
      || actionPath === setOnOffEP || actionPath === setActivePowerEP || actionPath === setVPPEP
      || actionPath === getDeviceList2EP;
    const window = shortWindow ? WINDOW_SHORT : WINDOW_LONG;

    // cache lifetime: writes never cached, plant lists an hour (ten calls per day, docs 2.4 / 2.5)
    let ttl = 5 * 60 * 1000;
    if (actionPath === getPlantListEP || actionPath === getPlantListUserEP) {
      ttl = 60 * 60 * 1000;
    }
    if (actionPath === getVPPEP || actionPath === getActivePowerEP) {
      ttl = 5 * 1000;
    }
    if (actionPath === setOnOffEP || actionPath === setActivePowerEP || actionPath === setVPPEP) {
      ttl = 0;
    }

    const cacheKey = this._requestKey(actionPath, data);
    const now = Date.now();
    const cached = responseCache.get(cacheKey);
    if (ttl > 0 && cached && cached.expiresAt > now) return cached.data;

    if (ttl > 0 && pendingRequests.has(cacheKey)) return pendingRequests.get(cacheKey);

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

      // parsed inside the task: FREQUENTLY_ACCESS arrives as an HTTP 200, and the limiter must see it
      const jsonRes = await enqueue({
        accountKey: `${this._accountKey()}__${this.host}`,
        requestKey: cacheKey,
        window,
        rateLimitedMessage: this._t('errors.rateLimited', 'Too many requests. Wait 5 minutes.'),
        task: async () => {
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
          } catch (error) {
            // our abort, or a host unreachable or dropping: 'fetch failed', 'terminated' mid-body (Node 24)
            if (error.name !== 'AbortError' && !['fetch failed', 'terminated'].includes(error.message)) throw error;
            const timedOut = error.name === 'AbortError';
            const err = Error(timedOut
              ? this._t('errors.timeout', 'The Growatt server did not answer in time.')
              : this._t('errors.unreachable', 'The Growatt server cannot be reached. Check the internet connection.'));
            err.reason = timedOut ? 'TIMEOUT' : 'NETWORK';
            throw err;
          } finally {
            clearTimeout(timeoutId);
          }

          this.lastResponse = body || status;

          if (status !== 200) {
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
        },
      }).catch((error) => {
        // a server answer, not a local refusal or a network failure
        if (error.errorCode !== undefined) {
          capture.record(actionPath, data, { error: { reason: error.reason || null, errorCode: error.errorCode, message: error.message } });
        }
        throw error;
      });
      capture.record(actionPath, data, { response: jsonRes?.data });

      if (ttl > 0) {
        responseCache.set(cacheKey, { expiresAt: Date.now() + ttl, data: jsonRes });
        if (responseCache.size > MAX_CACHED) pruneCache(Date.now());
      }
      return jsonRes;
    })();

    if (ttl > 0) {
      pendingRequests.set(cacheKey, requestPromise);
      requestPromise.finally(() => {
        pendingRequests.delete(cacheKey);
      }).catch(() => {});
    }

    return requestPromise;
  }

}

// For the offline tests only (test/fixtures.js)
GrowattClient.__testHooks = {
  // also detaches the store, so a previous run's state cannot be read back
  reset() {
    storeDisabled = true;
    accounts.clear();
    cooldowns.clear();
    responseCache.clear();
    pendingRequests.clear();
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    store = null;
    storeIsHomey = false;
    storeLoaded = false;
  },
  setSpacing(ms) {
    requestSpacing = ms;
  },
};

module.exports = GrowattClient;

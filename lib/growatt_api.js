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
// Per-request rate limiter
//
// Settled empirically on 2026-09-03 (zzz_docs/API-FIELD-NOTES.md §11): Growatt keys its rate
// limit on the exact request - the token, the endpoint AND the request parameters - for the
// window that endpoint documents. Repeat one request inside its window and only that request is
// refused; every other request, on the same endpoint or any other, is served in the same second.
// A trip is NOT an account-wide cooldown.
//
// So there is nothing to discover at runtime and nothing to adapt. This replaces an adaptive
// per-account limiter written before the shape was known, which on a single trip held the whole
// account down for five minutes - turning a refusal the server had scoped to one request into an
// outage for every device on the account.
//
// What actually keeps the app off the limit is the response cache in _makeRequest: it is keyed on
// the same (endpoint, params) pair with the same windows, and app.js builds one client per account
// that all of its devices share. The map below is the backstop for what the cache cannot see - a
// second client for the same account (discoverHost), an uncached write, or a repeat the server
// refuses anyway.
//
// Windows are the vendor's own, from the "Remarks" block on each endpoint page in
// zzz_docs/online api docs/: bulk data reads once per 5 minutes, per-device control and parameter
// reads once per 5 seconds. Error code 10012 / FREQUENTLY_ACCESS is what a repeat earns.
// ---------------------------------------------------------------------------

const REQUEST_SPACING = 3000; // politeness between calls on one account; not a documented limit
const WINDOW_LONG = 5 * 60 * 1000; // bulk data reads
const WINDOW_SHORT = 5 * 1000; // control and parameter endpoints
const MAX_COOLDOWNS = 500; // prune threshold; entries expire on their own within WINDOW_LONG

// accountKey -> { queue, processing, lastRequestAt }. Serialization and spacing only, so one
// account's calls never race each other and discoverHost()'s clients share a single queue.
const accounts = new Map();

// requestKey -> epoch ms before which repeating that exact request would be refused.
const cooldowns = new Map();

// requestKey -> { timestamp, data }, and the in-flight promises for the same keys. Shared across
// every client for one account, because the server's identity is the account, not the client
// object: discoverHost() builds a throwaway client per host, and pairing builds one per driver.
// A per-instance cache left those unable to answer a repeat they had every right to answer, so
// the cooldown below refused them instead - which is what broke pairing a second driver on an
// account within five minutes of the first. Cache and cooldown are keyed identically on purpose:
// while a request is inside its window there is always a cached response to serve, so the refusal
// path is reached only by the uncached write endpoints and by a genuine server trip.
const responseCache = new Map();
const pendingRequests = new Map();
const MAX_CACHED = 500;

function pruneCache(now) {
  for (const [key, entry] of responseCache) {
    if (entry.expiresAt <= now) responseCache.delete(key);
  }
}

// Cooldowns outlive the process on purpose. The rate limit itself is fixed and documented, so
// there is nothing to LEARN across a restart - but which requests are currently inside their
// window is state the server keeps and we must keep too. Dropping it meant a restart re-issued
// the boot poll for devices polled moments earlier and earned a real trip, which then refused the
// getLastData that pairing needs - an account with a working battery offered nothing to pair.
// Only cooldowns are persisted, not responses: it costs a few hundred bytes, and a device keeps
// its last capability values through a restart anyway.
// Cooldowns AND cached responses outlive the process, together. Persisting only the cooldowns was
// worse than persisting neither: a restart then remembered that a request was inside its window
// but had thrown away the answer it was holding, so every such request was refused with nothing to
// serve - which is what met a user pairing a driver moments after the app restarted. Kept as one
// unit, a restart behaves as if the process had never stopped: inside the window, answer from
// cache; outside it, call.
const STORE_KEY = 'apiRequestState';
const PERSIST_DEBOUNCE_MS = 5000; // one write per burst of calls, not one per call
const MAX_PERSISTED_BYTES = 256 * 1024;
let store = null;
let storeIsHomey = false;
let storeLoaded = false;
let persistTimer = null;

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
      } catch (e) { /* best effort */ }
    },
  };
}

function makeFileStore() {
  const file = path.join(os.tmpdir(), 'com.growatt.requeststate.json');
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

function writeState() {
  if (!store) return;
  const now = Date.now();
  const value = { cooldowns: {}, cache: {} };
  for (const [key, until] of cooldowns) {
    if (until > now) value.cooldowns[key] = until;
  }
  const live = [];
  for (const [key, entry] of responseCache) {
    if (entry.expiresAt > now) live.push([key, entry, JSON.stringify(entry.data).length]);
  }
  // Smallest first, so if the budget runs out it is a bulky lastData payload that is dropped and
  // never the few hundred bytes of plant and device lists that pairing cannot proceed without.
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
  if (!store || persistTimer) return;
  // eslint-disable-next-line homey-app/global-timers
  persistTimer = setTimeout(() => {
    persistTimer = null; writeState();
  }, PERSIST_DEBOUNCE_MS);
  if (typeof persistTimer.unref === 'function') persistTimer.unref();
}

// Called from the constructor, before any request can be enqueued. A Homey reference wins over a
// file store and may arrive second (a client built without one - e.g. inside a test - can come
// first), so upgrading is allowed; downgrading is not. Reading back happens once per store, not
// once per client - discoverHost() alone builds one for every host it probes.
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

// Key ordering must not decide identity: { deviceSn, deviceType } and { deviceType, deviceSn } are
// the same request to the server, so they have to hash the same here and in the response cache.
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
      // This exact request is inside its window. Making it would earn a FREQUENTLY_ACCESS and
      // restart the clock, so refuse it here instead, with the same reason code a real trip
      // carries - common_device.js#doPoll's backoff and #startListeners' transient-error
      // suppression behave unchanged. Nothing else on the account is held back.
      const error = Error(rateLimitedMessage);
      error.reason = 'RATE_LIMITED';
      reject(error);
      continue;
    }
    const wait = (account.lastRequestAt + REQUEST_SPACING) - now;
    if (wait > 0) {
      // eslint-disable-next-line homey-app/global-timers
      await new Promise((r) => setTimeout(r, wait));
    }
    account.lastRequestAt = Date.now();
    try {
      const result = await task();
      account.lastRequestAt = Date.now();
      noteRequest(requestKey, window);
      resolve(result);
    } catch (error) {
      account.lastRequestAt = Date.now();
      // branch on the stable reason code, never on the message text - that one is localized
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
// Host discovery probes every server at once, so a dead one must not hold the whole sweep for as
// long as a real call would wait. Five of these in parallel still finish inside the pairing dialog.
const DISCOVERY_TIMEOUT = 8000;

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
    bindStore(this.homey);
  }

  _t(key, fallback) {
    return translate(this.homey, key, fallback);
  }

  // Whose queue this client shares: the account, not the host. discoverHost() builds one client
  // per host for the same credentials, and those must not race each other.
  _accountKey() {
    return `${this.user_name || ''}__${this.token || ''}`;
  }

  // What the server actually keys its rate limit on: account + endpoint + parameters. The host is
  // in there too - the regional servers are separate backends, and a response cached from one must
  // never be handed back as another's, which would let discoverHost() pick the wrong host.
  _requestKey(actionPath, data) {
    return `${this._accountKey()}__${this.host}__${actionPath}_${stableParams(data)}`;
  }

  // When this exact request may be repeated, as an epoch ms timestamp; 0 when it is free to make.
  // Lets a caller skip a cycle instead of enqueueing something that can only come back refused - a
  // refusal it would otherwise log, and emit to devices, as if a real attempt had failed.
  cooldownUntil(actionPath, data) {
    const until = cooldowns.get(this._requestKey(actionPath, data)) || 0;
    return until > Date.now() ? until : 0;
  }

  // The one app.js#pollDevice needs, without making it name endpoints: would THIS device's own
  // last-data poll be refused? Another device on the same account is unaffected. A cached response
  // means the call will be answered rather than refused, so it is not a cooldown as far as the
  // caller is concerned - which is what lets devices pick their values straight back up after a
  // restart instead of sitting out the remainder of the window.
  lastDataCooldownUntil(opts) {
    const key = this._requestKey(getLastDataEP, { ...opts });
    const cached = responseCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return 0;
    const until = cooldowns.get(key) || 0;
    return until > Date.now() ? until : 0;
  }

  // eslint-disable-next-line no-console
  static async discoverHost({
    username, token, homey, log = console.log,
  }) {
    const hosts = ['openapi.growatt.com', 'openapi-us.growatt.com', 'openapi-au.growatt.com', 'openapi-cn.growatt.com', 'ess-server.atesspower.com'];

    // Probed in PARALLEL, and with a shorter timeout than a normal call. One after another this
    // was five 20-second timeouts plus the queue's spacing between them - over a minute for a
    // token that is simply wrong, which the pairing dialog abandoned at 30 seconds showing
    // nothing at all. In parallel the whole sweep costs one timeout.
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

    log(`Trying login on ${hosts.length} servers...`);
    const attempts = await Promise.all(hosts.map((host) => probe(host, (c) => c.getPlantListUser())));
    const errors = new Map(attempts.filter((a) => a.error).map((a) => [a.host, a.error]));
    attempts.filter((a) => a.error).forEach(({ host, error }) => {
      log(`  ${host} rejected: ${error.reason || 'unknown'}${error.errorCode !== undefined ? ` (code ${error.errorCode})` : ''}`);
    });

    // Host order is a preference, so honour it rather than whichever answered first
    const winner = hosts.map((h) => attempts.find((a) => a.host === h)).find((a) => a && a.result);
    if (winner) {
      log(`Successfully connected to ${winner.host}`);
      return { host: winner.host, info: winner.result };
    }

    // A refusal is not a wrong host - only the right one has an account to rate limit - and it
    // clears itself, so it must not be reported as a broken account.
    const rateLimited = hosts.map((h) => errors.get(h)).find((e) => e && e.reason === 'RATE_LIMITED');
    if (rateLimited) throw rateLimited;

    // Which server does this username actually live on? That is the only one whose failure says
    // anything useful. Reporting `lastError` instead meant reporting whichever host happened to be
    // LAST in the list - ess-server.atesspower.com, whose answer for any normal Growatt account is
    // `error_userNotExist`. That is how an account that exists, and logs in on the web perfectly
    // well, came to be told it does not exist.
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
    // The token authenticates but this account is not assigned to it - the one case where
    // contacting Growatt really is the answer. Anything else reports what actually happened.
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
    // The window the server enforces on a repeat of this exact request.
    const shortWindow = actionPath === getVPPEP || actionPath === getActivePowerEP
      || actionPath === setOnOffEP || actionPath === setActivePowerEP || actionPath === setVPPEP
      || actionPath === getDeviceList2EP;
    const window = shortWindow ? WINDOW_SHORT : WINDOW_LONG;

    // How long a response may be served from cache. Deliberately not the same thing as the window
    // above: a write must never be answered from cache, however recently it was made.
    let ttl = 5 * 60 * 1000; // 5 minutes
    if (actionPath === getVPPEP || actionPath === getActivePowerEP) {
      ttl = 5 * 1000; // 5 seconds
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

      // The response is parsed INSIDE the queued task on purpose: FREQUENTLY_ACCESS arrives as a
      // 200 with an error code in the body, so the limiter can only see a trip - and open the
      // window on this request - if the mapping happens before the task returns.
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
        },
      });

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

module.exports = GrowattClient;

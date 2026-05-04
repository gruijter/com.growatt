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

// Global request queue to prevent API rate limiting (FREQUENTLY_ACCESS)
const requestQueue = [];
let isProcessingQueue = false;
let lastGlobalRequestTime = 0;

async function processRequestQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  while (requestQueue.length > 0) {
    const { task, resolve, reject } = requestQueue.shift();
    const now = Date.now();
    const timeSinceLast = now - lastGlobalRequestTime;
    if (timeSinceLast < 2000) {
      // eslint-disable-next-line homey-app/global-timers
      await new Promise((r) => setTimeout(r, 2000 - timeSinceLast));
    }
    lastGlobalRequestTime = Date.now();
    try {
      const result = await task();
      resolve(result);
    } catch (error) {
      reject(error);
    }
    lastGlobalRequestTime = Date.now();
  }
  isProcessingQueue = false;
}

function enqueue(task) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ task, resolve, reject });
    // eslint-disable-next-line no-console
    processRequestQueue().catch((error) => console.error('Queue processing error:', error));
  });
}

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
    this.host = options.host || defaultHost;
    this.port = defaultPort;
    this.timeout = options.timeout || defaultTimeout;
    this.cookie = undefined;
    this.lastResponse = undefined;
    this.cache = {};
    this.pendingRequests = {};
  }

  // eslint-disable-next-line no-console
  static async discoverHost({ username, token, log = console.log }) {
    const hosts = ['openapi.growatt.com', 'openapi-us.growatt.com', 'openapi-au.growatt.com', 'openapi-cn.growatt.com', 'ess-server.atesspower.com'];
    let lastError;
    let info = false;
    let selectedHost = null;

    for (const host of hosts) {
      const client = new GrowattClient({ user_name: username, token, host });
      try {
        log(`Trying login on ${host}...`);
        info = await client.getPlantListUser();
        if (info) {
          selectedHost = host;
          log(`Successfully connected to ${host}`);
          break;
        }
      } catch (e) {
        const msg = e.message || e;
        if (msg === 'Too many requests. Wait 5 minutes.') throw e;
        lastError = e;
      }
    }

    if (!info) {
      let userInfo;
      for (const host of hosts) {
        const client = new GrowattClient({ user_name: username, token, host });
        try {
          userInfo = await client.checkUser();
          if (userInfo && userInfo.userNameExists) {
            selectedHost = host;
            break;
          }
        } catch (e) {}
      }
      let errorMessage = 'API Problem. Please contact service.nl@growatt.com to fix your account';
      if (!userInfo || !userInfo.userNameExists) errorMessage = lastError?.message || 'User does not exist on any server';
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

  async setChargeSetpoint(opts) {
    const data = {
      deviceSn: opts.deviceSn,
      deviceType: opts.deviceType,
      value: '1',
      setType: 'set_param_25', // remote power control enable
    };
    const res = await this._makeRequest(setVPPEP, data);
    data.setType = 'set_param_26'; // REMOTE POWER CONTROL CHARGING TIME
    data.value = '5'; // 5 minutes
    await this._makeRequest(setVPPEP, data);
    data.setType = 'set_param_27'; // REMOTE (DIS)CHARGE POWER (discharge -100 ... +100 charge)
    data.value = opts.value;
    await this._makeRequest(setVPPEP, data);
    return res.data;
  }

  async getChargeSetpoint(opts) {
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

  _mapApiError(msg) {
    let message = msg;
    if (typeof message === 'string' && message.includes('"message":')) {
      try {
        message = JSON.parse(message).message;
      } catch (e) { /* ignore */ }
    }
    if (message === 'error_permission_denied') return 'Permission denied. Check your Token.';
    if (typeof message === 'string' && message.toUpperCase().includes('FREQUENTLY_ACCESS')) return 'Too many requests. Wait 5 minutes.';
    return message;
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

      const res = await enqueue(async () => {
        const controller = new AbortController();
        // eslint-disable-next-line homey-app/global-timers
        const timeoutId = setTimeout(() => controller.abort(), timeout || this.timeout);
        options.signal = controller.signal;
        return fetch(url, options).finally(() => clearTimeout(timeoutId));
      });

      const resBody = await res.text();
      this.lastResponse = resBody || res.status;

      if (res.status !== 200) {
        throw Error(`HTTP request Failed. ${this.lastResponse}`);
      }

      if (typeof res.headers.getSetCookie === 'function') {
        const cookies = res.headers.getSetCookie();
        if (cookies && cookies.length > 0) this.cookie = cookies;
      } else {
        const cookie = res.headers.get('set-cookie');
        if (cookie) this.cookie = [cookie];
      }

      const contentType = res.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw Error(`Expected json but received ${contentType}: ${resBody}`);
      }

      const jsonRes = JSON.parse(resBody);
      const errorCode = jsonRes?.error_code !== undefined ? jsonRes.error_code : jsonRes?.code;
      if (errorCode !== 0) {
        const err = Error(this._mapApiError(jsonRes?.error_msg || jsonRes?.message || resBody));
        err.errorCode = errorCode;
        throw err;
      }
      if (errorCode === 0 && ttl > 0) {
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

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

// ShinePhone web login: https://openapi.growatt.com/login
// API Docs: https://www.showdoc.com.cn/2598832417617967/11558377939801334

'use strict';

const https = require('https');
const qs = require('node:querystring');

// API host
const defaultHost = 'openapi.growatt.com';
const defaultPort = 443;
const defaultTimeout = 20000;

// Endpoints
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
class growattClient {

  constructor(opts) {
    const options = opts || {};
    this.user_name = options.user_name;
    this.token = options.token;
    // this.password = options.password;
    this.plant_id = options.plant_id;
    this.host = defaultHost;
    this.port = defaultPort;
    this.timeout = options.timeout || defaultTimeout;
    this.cookie = undefined;
    this.lastResponse = undefined;
  }

  async getPlantList(opts) {
    try {
      const queery = {
        // search_type: '',
        // search_keyword: '',
        perPage: 100,
      };
      if (opts) Object.assign(queery, opts);
      const res = await this._makeRequest(`${getPlantListEP}?${qs.stringify(queery)}`);
      return Promise.resolve(res.data);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getPlantListUser(opts) {
    try {
      const data = {
        // search_type: '',
        // search_keyword: '',
        user_name: this.user_name,
        perPage: 100,
      };
      if (opts) Object.assign(data, opts);
      const res = await this._makeRequest(getPlantListUserEP, data);
      return Promise.resolve(res.data);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getPlantData(opts) {
    try {
      const queery = {
        plant_id: this.plant_id,
      };
      if (opts) Object.assign(queery, opts);
      const res = await this._makeRequest(`${getPlantDataEP}?${qs.stringify(queery)}`);
      return Promise.resolve(res.data);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getPlantDetails(opts) {
    try {
      const queery = {
        plant_id: this.plant_id,
      };
      if (opts) Object.assign(queery, opts);
      const res = await this._makeRequest(`${getPlantDetailsEP}?${qs.stringify(queery)}`);
      return Promise.resolve(res.data);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getDeviceList(opts) {
    try {
      const queery = {
        plant_id: this.plant_id,
        perpage: 100,
      };
      if (opts) Object.assign(queery, opts);
      const res = await this._makeRequest(`${getDeviceListEP}?${qs.stringify(queery)}`);
      return Promise.resolve(res.data);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getDeviceList2(opts) {
    try {
      const data = {
        page: 1,
      };
      if (opts) Object.assign(data, opts);
      const res = await this._makeRequest(getDeviceList2EP, data);
      return Promise.resolve(res.data);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getDataLoggerList(opts) {
    try {
      const queery = {
        plant_id: this.plant_id,
        perpage: 100,
      };
      if (opts) Object.assign(queery, opts);
      const res = await this._makeRequest(`${getDataLoggerListEP}?${qs.stringify(queery)}`);
      return Promise.resolve(res.data);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getDeviceInfo(opts) {
    try {
      const data = {
        // deviceSn: 'RDL3CL30A8', // comma seperated list xxxxxxx,xxxxxxx,xxxxxxx
        // deviceType: 'min', // inv, storage, max, sph, spa, min, wit, sph-s, noah
      };
      if (opts) Object.assign(data, opts);
      const res = await this._makeRequest(getDeviceInfoEP, data);
      return Promise.resolve(res.data);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getLastData(opts) {
    try {
      const data = {
        // deviceSn: 'RDL3CL30A8', // comma seperated list xxxxxxx,xxxxxxx,xxxxxxx
        // deviceType: 'min', // inv, storage, max, sph, spa, min, wit, sph-s, noah
      };
      if (opts) Object.assign(data, opts);
      const res = await this._makeRequest(getLastDataEP, data);
      return Promise.resolve(res.data);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getVPP(opts) {
    try {
      const data = {
        // deviceSn: 'FDCJQ00003',
        // setType: 'set_param_34', // https://www.showdoc.com.cn/p/fc84c86facd79b3692f585fbd7a6e33b
        // deviceType: 'min', // inv, storage, max, sph, spa, min, wit, sph-s, noah",
      };
      if (opts) Object.assign(data, opts);
      const res = await this._makeRequest(getVPPEP, data);
      return Promise.resolve(res.data);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async setVPP(opts) {
    try {
      const data = {
        deviceSn: opts.deviceSn,
        deviceType: opts.deviceType,
        setType: opts.value?.setType, // https://www.showdoc.com.cn/p/fc84c86facd79b3692f585fbd7a6e33b
        value: opts.value?.value, // value to set
      };
      // if (opts) Object.assign(data, opts);
      const res = await this._makeRequest(setVPPEP, data);
      return Promise.resolve(res.data);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async setChargeSetpoint(opts) {
    try {
      const data = {
        deviceSn: opts.deviceSn,
        deviceType: opts.deviceType,
        value: '1',
        setType: 'set_param_25', // remote power control enable
      };
      console.log(data);
      const res = await this._makeRequest(setVPPEP, data);
      console.log(res);
      data.setType = 'set_param_26'; // REMOTE POWER CONTROL CHARGING TIME
      data.value = '5'; // 5 minutes
      console.log(data);
      const res2 = await this._makeRequest(setVPPEP, data);
      console.log(res2);
      data.setType = 'set_param_27'; // REMOTE (DIS)CHARGE POWER (discharge -100 ... +100 charge)
      data.value = opts.value;
      console.log(data);
      const res3 = await this._makeRequest(setVPPEP, data);
      console.log(res3);
      return Promise.resolve(res.data);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getChargeSetpoint(opts) {
    try {
      const data = {
        // deviceSn: 'FQP0E3D0JR',
        // deviceType: 'min',
        setType: 'set_param_27', //
      };
      if (opts) Object.assign(data, opts);
      const res = await this._makeRequest(getVPPEP, data);
      return Promise.resolve(res.data);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async setOnOff(opts) {
    try {
      const data = {
        // deviceSn: 'FDCJQ00003',
        // deviceType: 'min', // inv, storage, max, sph, spa, min, wit, sph-s, noah",
        // value: 1, // 0=off, 1=on
      };
      if (opts) Object.assign(data, opts);
      const res = await this._makeRequest(setOnOffEP, data);
      return Promise.resolve(res.data);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async setActivePower(opts) {
    try {
      const data = {
        // deviceSn: 'FDCJQ00003',
        // deviceType: 'min', // inv, storage, max, sph, spa, min, wit, sph-s, noah",
        // value: ,
      };
      if (opts) Object.assign(data, opts);
      const res = await this._makeRequest(setActivePowerEP, data);
      return Promise.resolve(res.data);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getActivePower(opts) {
    try {
      const data = {
        // deviceSn: 'FDCJQ00003',
        // deviceType: 'min', // inv, storage, max, sph, spa, min, wit, sph-s, noah",
      };
      if (opts) Object.assign(data, opts);
      const res = await this._makeRequest(getActivePowerEP, data);
      return Promise.resolve(res.data);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async _makeRequest(actionPath, data, timeout, method) {
    try {
      const postData = data === null ? null : qs.stringify(data);
      const headers = {
        accept: 'application/json;charset=UTF-8',
        token: this.token,
        'Content-Type': 'application/json;charset=UTF-8',
        // 'User-Agent': 'HomeyApp 2.0',
        Connection: 'keep-alive',
      };
      if (this.cookie) headers.Cookie = this.cookie;
      const options = {
        hostname: this.host,
        port: this.port,
        path: actionPath,
        headers,
        method: 'GET',
      };
      if ((data === null) || (data && data !== '')) options.method = 'POST';
      if (method) options.method = method;
      if (options.method === 'GET') options.headers['Content-Type'] = 'application/json;charset=UTF-8';
      if (options.method === 'POST') options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      // console.log(options);
      // console.log(postData);
      const result = await this._makeHttpsRequest(options, postData, timeout);
      this.lastResponse = result.body || result.statusCode;
      // console.log(this.lastResponse);
      const contentType = result.headers['content-type'];
      // console.dir(result.headers, { depth: null });
      // find errors
      if (result.statusCode !== 200) {
        this.lastResponse = result.body || result.statusCode;
        throw Error(`HTTP request Failed. ${this.lastResponse}`);
      }
      if (result.headers['set-cookie']) this.cookie = result.headers['set-cookie'];
      if (!contentType || !contentType.includes('application/json')) {
        throw Error(`Expected json but received ${contentType}: ${result.body}`);
      }
      const jsonRes = JSON.parse(result.body);
      const errorCode = jsonRes?.error_code !== undefined ? jsonRes.error_code : jsonRes?.code;
      if (errorCode !== 0) throw Error(jsonRes?.error_msg || jsonRes?.message || result.body);
      // console.dir(result.body, { depth: null });
      return Promise.resolve(jsonRes);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  _makeHttpsRequest(options, postData, timeout) {
    return new Promise((resolve, reject) => {
      const opts = options;
      opts.timeout = timeout || this.timeout;
      const req = https.request(opts, (res) => {
        let resBody = '';
        res.on('data', (chunk) => {
          resBody += chunk;
        });
        res.once('end', () => {
          this.lastResponse = resBody;
          if (!res.complete) {
            return reject(Error('The connection was terminated while the message was still being sent'));
          }
          res.body = resBody;
          return resolve(res);
        });
      });
      req.on('error', (e) => {
        req.destroy();
        this.lastResponse = e;
        return reject(e);
      });
      req.on('timeout', () => {
        req.destroy();
      });
      req.end(postData);
    });
  }

}

module.exports = growattClient;

// ShinePhone
// https://openapi.growatt.com/login

// Docs:
// https://www.showdoc.com.cn/2598832417617967/11558377939801334

// Postman:
// https://www.postman.com/gold-water-163355/growatt-public/overview

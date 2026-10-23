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

/*
Raw API responses in the app log, so a user's diagnostics report doubles as test material (as
com.foxess). Each read request is logged once per arm (app start, device restart, pair, repair),
in chunks. `node test/from-logs.js <report.txt>` turns a report back into zzz_responses/ fixtures.
*/

const captureLog = require('./captureLog');

// Fixture names as zzz_collect.js writes them. Writes are never captured.
const NAMES = {
  '/v1/user/check_user': 'checkUser',
  '/v1/plant/list': 'getPlantList',
  '/v1/plant/user_plant_list': 'getPlantListUser',
  '/v1/plant/data': 'getPlantData',
  '/v1/plant/details': 'getPlantDetails',
  '/v1/device/list': 'getDeviceList',
  '/v4/new-api/queryDeviceList': 'getDeviceList2',
  '/v1/device/datalogger/list': 'getDataLoggerList',
  '/v4/new-api/queryDeviceInfo': 'getDeviceInfo',
  '/v4/new-api/queryLastData': 'getLastData',
  '/v4/new-api/readVppParameter': 'getVPP',
  '/v4/new-api/readPower': 'getActivePower',
};

// The parameters that select a response (test/fixtures.js matches on these); never credentials.
const ID_KEYS = ['deviceSn', 'deviceType', 'setType', 'plant_id'];

const MAX_PER_ARM = 60;

// Location and contact details (plant lists and details); serial numbers and plant names are kept.
const PII = /^(latitude|longitude|address\d?|postal|postcode|city|state|email|phone|mobile|image_url|.*contact)$/i;

const redact = (value) => {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, v]) => [key, PII.test(key) || /^(latitude|longitude)_/i.test(key) ? '<redacted>' : redact(v)]));
};

const requestOf = (data) => Object.fromEntries(ID_KEYS
  .filter((key) => data && data[key] !== undefined && data[key] !== '')
  .map((key) => [key, String(data[key])]));

const core = captureLog('GROWATT');
let log = null;

module.exports = {

  NAMES,

  /** Where captures go: the app's logger, so they land in diagnostics reports. */
  setLog(fn) {
    log = typeof fn === 'function' ? fn : null;
  },

  /**
   * Arm capturing: the next response of every read request is logged once.
   * @param {string} why shown in the log
   * @param {object} [options]
   * @param {boolean} [options.force] skip the cooldown (app start, pair and repair)
   */
  arm(why, options) {
    return core.arm(why, options);
  },

  /**
   * Log one server answer while armed, once per request per arm.
   * @param {string} actionPath the API path, with its query for GET requests
   * @param {object} data the request parameters
   * @param {object} outcome { response } (the `data` of the answer) or { error }
   */
  record(actionPath, data, outcome) {
    // diagnostics must never fail the request it rides on
    try {
      // the GET endpoints carry their parameters in the path
      const [endpoint, query] = String(actionPath).split('?');
      if (!log || !NAMES[endpoint]) return false;
      const request = requestOf({ ...Object.fromEntries(new URLSearchParams(query || '')), ...data });
      if (core.claimed >= MAX_PER_ARM || !core.claim(`${NAMES[endpoint]}?${JSON.stringify(request)}`)) return false;
      return core.write(`c${core.claimed}`, { endpoint, request, ...redact(outcome) }, log, { label: NAMES[endpoint] });
    } catch {
      return false;
    }
  },

  /**
   * Read captures back out of a diagnostics report. A later arm reuses names, so each start line
   * begins a new capture.
   * @param {string} text the whole report
   * @returns {{captures: object[], errors: string[]}} { endpoint, request, response|error } each
   */
  parseLog(text) {
    const { entries, errors } = core.parse(text);
    return { captures: entries.map((entry) => entry.value), errors };
  },

};

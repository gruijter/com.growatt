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

const START = '===GROWATT-CAPTURE-START';
const END = '===GROWATT-CAPTURE-END';
const CHUNK = 700; // characters per log line
const MAX_BYTES = 32 * 1024;
const MAX_PER_ARM = 60;
const REARM_COOLDOWN = 60 * 1000;

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

let log = null;
let isArmed = false;
let captured = new Set();
let reason = '';
let lastArmAt = 0;

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
  arm(why, { force = false } = {}) {
    const now = Date.now();
    if (!force && (now - lastArmAt) < REARM_COOLDOWN) return false;
    lastArmAt = now;
    reason = why;
    isArmed = true;
    captured = new Set();
    return true;
  },

  /**
   * Log one server answer while armed, once per request per arm.
   * @param {string} actionPath the API path, with its query for GET requests
   * @param {object} data the request parameters
   * @param {object} outcome { response } (the `data` of the answer) or { error }
   */
  record(actionPath, data, outcome) {
    // the GET endpoints carry their parameters in the path
    const [endpoint, query] = String(actionPath).split('?');
    if (!isArmed || !log || !NAMES[endpoint]) return false;
    const request = requestOf({ ...Object.fromEntries(new URLSearchParams(query || '')), ...data });
    const id = `${NAMES[endpoint]}?${JSON.stringify(request)}`;
    if (captured.has(id) || captured.size >= MAX_PER_ARM) return false;
    captured.add(id);

    const name = `c${captured.size}`;
    let text;
    try {
      text = JSON.stringify({ endpoint, request, ...redact(outcome) });
    } catch (error) {
      log(`capture ${NAMES[endpoint]}: could not serialise (${error.message})`);
      return false;
    }
    if (text.length > MAX_BYTES) {
      log(`capture ${NAMES[endpoint]}: skipped, ${text.length} bytes exceeds the ${MAX_BYTES} byte cap`);
      return false;
    }
    const chunks = Math.ceil(text.length / CHUNK);
    log(`${START} ${name} ${chunks} ${NAMES[endpoint]} (${reason})===`);
    for (let i = 0; i < chunks; i += 1) log(`${name}|${i + 1}|${text.slice(i * CHUNK, (i + 1) * CHUNK)}`);
    log(`${END} ${name}===`);
    return true;
  },

  /**
   * Read captures back out of a diagnostics report; anchors on `<name>|<index>|`, so line prefixes
   * don't matter. A later arm reuses names, so each START begins a new capture.
   * @param {string} text the whole report
   * @returns {{captures: object[], errors: string[]}} { endpoint, request, response|error } each
   */
  parseLog(text) {
    const captures = [];
    const errors = [];
    const open = new Map(); // name -> { total, parts }
    const finish = (name) => {
      const { total, parts } = open.get(name);
      open.delete(name);
      const missing = [];
      let joined = '';
      for (let i = 1; i <= total; i += 1) {
        if (!parts.has(i)) missing.push(i);
        else joined += parts.get(i);
      }
      if (missing.length) {
        errors.push(`${name}: missing chunk(s) ${missing.join(', ')} of ${total} - report truncated?`);
        return;
      }
      try {
        captures.push(JSON.parse(joined));
      } catch (error) {
        errors.push(`${name}: reassembled text is not valid JSON (${error.message})`);
      }
    };
    for (const line of String(text).split(/\r?\n/)) {
      const header = line.match(new RegExp(`${START} (c\\d+) (\\d+)`));
      if (header) {
        if (open.has(header[1])) finish(header[1]);
        open.set(header[1], { total: Number(header[2]), parts: new Map() });
        continue;
      }
      const end = line.match(new RegExp(`${END} (c\\d+)`));
      if (end && open.has(end[1])) {
        finish(end[1]);
        continue;
      }
      const body = line.match(/(c\d+)\|(\d+)\|(.*)$/);
      if (body && open.has(body[1])) open.get(body[1]).parts.set(Number(body[2]), body[3]);
    }
    [...open.keys()].forEach(finish);
    return { captures, errors };
  },

};

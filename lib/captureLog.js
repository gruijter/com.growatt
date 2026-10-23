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
 * Captures in the app log, so a user's diagnostics report doubles as test material: a JSON value
 * logged in chunks between ===<TAG>-CAPTURE-START/END=== markers, and read back from a report.
 * One file, kept identical (apart from the licence header) in com.growatt, com.foxess,
 * com.solaredge and com.solarwatt. What is captured, its name and its redaction stay in each
 * app's own capture module.
 */

const CHUNK = 700; // characters per log line
const REARM_COOLDOWN = 60 * 1000;

/**
 * @param {string} tag the marker tag, e.g. 'GROWATT'
 * @param {object} [options]
 * @param {number} [options.maxBytes] the largest capture, as JSON text
 */
module.exports = function captureLog(tag, { maxBytes = 32 * 1024 } = {}) {
  const START = `===${tag}-CAPTURE-START`;
  const END = `===${tag}-CAPTURE-END`;
  let isArmed = false;
  let reason = '';
  let lastArmAt = 0;
  let claimed = new Set();

  return {

    /**
     * Arm capturing: each key can be claimed once until the next arm.
     * @param {string} why shown in the log
     * @param {object} [options]
     * @param {boolean} [options.force] skip the cooldown (app start, pair and repair)
     * @returns {boolean} whether it armed
     */
    arm(why, { force = false } = {}) {
      const now = Date.now();
      if (!force && now - lastArmAt < REARM_COOLDOWN) return false;
      lastArmAt = now;
      reason = why;
      isArmed = true;
      claimed = new Set();
      return true;
    },

    /** Whether `key` is still to be captured in this arm; it is not after this. */
    claim(key) {
      if (!isArmed || claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },

    /** How many keys this arm claimed. */
    get claimed() {
      return claimed.size;
    },

    /**
     * Log `value` as JSON in chunks.
     * @param {string} name letters, digits and _, unique within an arm
     * @param {*} value
     * @param {Function} log the app/device logger
     * @param {object} [options]
     * @param {string} [options.label] in the start line after the chunk count, and in warnings
     * @param {string} [options.why] in the start line; the arm's reason by default
     * @returns {boolean} whether it was logged
     */
    write(name, value, log, { label = '', why = reason } = {}) {
      const what = label || name;
      let text;
      try {
        text = JSON.stringify(value);
      } catch (error) {
        log(`capture ${what}: could not serialise (${error.message})`);
        return false;
      }
      if (text.length > maxBytes) {
        log(`capture ${what}: skipped, ${text.length} bytes exceeds the ${maxBytes} byte cap`);
        return false;
      }
      const chunks = Math.ceil(text.length / CHUNK);
      log(`${START} ${name} ${chunks}${label ? ` ${label}` : ''} (${why})===`);
      for (let i = 0; i < chunks; i += 1) log(`${name}|${i + 1}|${text.slice(i * CHUNK, (i + 1) * CHUNK)}`);
      log(`${END} ${name}===`);
      return true;
    },

    /**
     * Read captures back out of a diagnostics report; anchors on `<name>|<index>|`, so line
     * prefixes don't matter. Each start line begins a new capture, also of a name seen before.
     * @param {string} text the whole report
     * @returns {{entries: {name: string, value: *}[], errors: string[]}} in the order logged
     */
    parse(text) {
      const entries = [];
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
          entries.push({ name, value: JSON.parse(joined) });
        } catch (error) {
          errors.push(`${name}: reassembled text is not valid JSON (${error.message})`);
        }
      };
      const header = new RegExp(`${START} (\\w+) (\\d+)`);
      const end = new RegExp(`${END} (\\w+)`);
      for (const line of String(text).split(/\r?\n/)) {
        const start = line.match(header);
        if (start) {
          if (open.has(start[1])) finish(start[1]);
          open.set(start[1], { total: Number(start[2]), parts: new Map() });
          continue;
        }
        const stop = line.match(end);
        if (stop && open.has(stop[1])) {
          finish(stop[1]);
          continue;
        }
        const body = line.match(/(\w+)\|(\d+)\|(.*)$/);
        if (body && open.has(body[1])) open.get(body[1]).parts.set(Number(body[2]), body[3]);
      }
      [...open.keys()].forEach(finish);
      return { entries, errors };
    },

  };
};

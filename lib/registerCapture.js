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
Raw registers in the app log, so a user's diagnostics report doubles as test material. Each
Modbus device logs its identity, detection and first poll once per (re)start or repair, in chunks.
One file, kept identical (apart from the licence header) in com.solarwatt, com.solaredge,
com.foxess and com.growatt; the capture tag comes from lib/modbusBrand.js.
*/

const captureLog = require('./captureLog');
const { captureTag } = require('./modbusBrand');

const core = captureLog(captureTag);

/** { "37609": "0d2a00fa…" }: each run of consecutive addresses as 4 hex digits per register. */
const toRuns = (registers) => {
  const runs = {};
  let start;
  let previous;
  for (const address of [...registers.keys()].sort((a, b) => a - b)) {
    if (previous === undefined || address !== previous + 1) {
      start = address;
      runs[start] = '';
    }
    runs[start] += registers.get(address).toString(16).padStart(4, '0');
    previous = address;
  }
  return runs;
};

/** The register map back from toRuns. */
const fromRuns = (runs) => {
  const registers = new Map();
  for (const [start, hex] of Object.entries(runs || {})) {
    for (let i = 0; i * 4 < hex.length; i += 1) {
      registers.set(Number(start) + i, parseInt(hex.slice(i * 4, i * 4 + 4), 16));
    }
  }
  return registers;
};

/**
 * Log a payload once in chunks. `name` is letters only, e.g. "batteryPoll".
 * @returns {boolean} whether it was logged
 */
const record = (name, payload, log) => core.write(name, payload, log, { why: payload.reason || '' });

/**
 * Read captures back out of a diagnostics report; anchors on `<name>|<index>|`, so line
 * prefixes don't matter. A name captured twice keeps the last.
 * @returns {{captures: object, errors: string[]}} parsed payloads by capture name
 */
const parseLog = (text) => {
  const { entries, errors } = core.parse(text);
  const captures = {};
  entries.forEach(({ name, value }) => {
    captures[name] = value;
  });
  return { captures, errors };
};

module.exports = {
  toRuns, fromRuns, record, parseLog,
};

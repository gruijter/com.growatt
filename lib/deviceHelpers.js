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
 * Device helpers. One file, kept identical (apart from the licence header) in com.solaredge (cloud
 * and Modbus devices) and com.growatt.
 */

/**
 * A counter that never falls, for Homey Energy, from one that can: a reading below the last one
 * (a reset, or old sessions leaving a rolling window) adds the difference to an offset in the
 * store, so the result continues where it was. A fall counts only when the next reading is low
 * too: a single low reading (a battery or session missing from one answer) would otherwise be
 * counted twice once the counter is back. Growth during those two readings is lost.
 * @param {Homey.Device} device keeps the offset in its store
 * @param {string} name store key prefix
 * @param {number} reading the source counter
 */
async function monotonic(device, name, reading) {
  const last = device.getStoreValue(`${name}Last`);
  let offset = device.getStoreValue(`${name}Offset`) || 0;
  if (!device.falling) device.falling = new Set();
  if (typeof last === 'number' && reading < last) {
    if (!device.falling.has(name)) {
      device.falling.add(name);
      device.log(`${device.getName()} ${name} fell from ${last} to ${reading}; held until the next reading`);
      return Math.round((last + offset) * 1000) / 1000;
    }
    device.falling.delete(name);
    offset += last - reading;
    device.log(`${device.getName()} ${name} fell from ${last} to ${reading}; offset now ${offset}`);
    await device.setStoreValue(`${name}Offset`, offset);
  } else {
    device.falling.delete(name);
  }
  if (reading !== last) await device.setStoreValue(`${name}Last`, reading);
  return Math.round((reading + offset) * 1000) / 1000;
}

/**
 * Continue a monotonic() counter on another source (e.g. more batteries added up) where it is now:
 * the next readings count from here, without a jump.
 * @param {Homey.Device} device
 * @param {string} name store key prefix, as for monotonic()
 * @param {number} reading the new source's counter
 */
async function rebase(device, name, reading) {
  const last = device.getStoreValue(`${name}Last`);
  if (typeof last !== 'number') return;
  const offset = device.getStoreValue(`${name}Offset`) || 0;
  device.log(`${device.getName()} ${name} rebased from ${last} to ${reading}`);
  await device.setStoreValue(`${name}Offset`, last + offset - reading);
  await device.setStoreValue(`${name}Last`, reading);
}

/** `date` in `timeZone` as YYYY-MM-DD. */
const dateIn = (date, timeZone) => new Intl.DateTimeFormat('en-CA', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);

/** `homey` is an EventEmitter (default ceiling 10) with one listener per device on `event`. */
function raiseListenerCeiling(homey, event) {
  if (typeof homey.setMaxListeners !== 'function') return;
  const needed = homey.listenerCount(event) + 12;
  if (homey.getMaxListeners() < needed) homey.setMaxListeners(needed);
}

module.exports = {
  dateIn, monotonic, raiseListenerCeiling, rebase,
};

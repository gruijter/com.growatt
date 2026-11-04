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
 * and Modbus devices), com.growatt, com.solarwatt, com.foxess, com.tigoenergy and com.sungrowpower.
 */

/** While the counter only grows, its last reading is stored at most this often. */
const SAVE_INTERVAL = 15 * 60 * 1000;
/** Below the 3 decimals of the result: a reading this little under the last one is held, not a fall. */
const TOLERANCE = 0.001;

const round3 = (x) => Math.round(x * 1000) / 1000;

/**
 * Last reading and offset, in memory so concurrent calls see each other's changes before the
 * store writes finish. After a start the last reading is the stored one, or the capability value
 * minus the offset when higher: the store lags, capability values persist (user-confirmed 2026-10-28).
 */
function lastOf(device, name, capability) {
  if (!device.counterLast) device.counterLast = new Map();
  if (!device.counterLast.has(name)) {
    const offset = device.getStoreValue(`${name}Offset`) || 0;
    const shown = device.hasCapability(capability) ? device.getCapabilityValue(capability) : null;
    const value = Math.max(...[device.getStoreValue(`${name}Last`), typeof shown === 'number' ? shown - offset : null]
      .filter((candidate) => typeof candidate === 'number' && Number.isFinite(candidate)));
    device.counterLast.set(name, { value: Number.isFinite(value) ? value : null, offset, savedAt: 0 });
  }
  return device.counterLast.get(name);
}

/**
 * A counter that never falls, for Homey Energy, from one that can: a reading below the last one
 * (a reset, or old sessions leaving a rolling window) adds the difference to an offset in the
 * store, so the result continues where it was. A fall counts only when the next reading is low
 * too: a single low reading (a battery or session missing from one answer) would otherwise be
 * counted twice once the counter is back. Growth during those two readings is lost.
 * @param {Homey.Device} device keeps the offset in its store
 * @param {string} name store key prefix
 * @param {number} reading the source counter
 * @param {string} [capability] the capability that shows the result, when not `name`
 */
async function monotonic(device, name, reading, capability = name) {
  const last = lastOf(device, name, capability);
  const { offset } = last;
  if (!device.falling) device.falling = new Set();
  if (typeof last.value === 'number' && reading < last.value - TOLERANCE) {
    if (!device.falling.has(name)) {
      device.falling.add(name);
      device.log(`${device.getName()} ${name} fell from ${last.value} to ${reading}; held until the next reading`);
      return round3(last.value + offset);
    }
    device.falling.delete(name);
    const newOffset = offset + last.value - reading;
    device.log(`${device.getName()} ${name} fell from ${last.value} to ${reading}; offset now ${newOffset}`);
    Object.assign(last, { value: reading, offset: newOffset, savedAt: Date.now() });
    // Last first: a restart between the two writes finds the old offset and sees the fall again
    await device.setStoreValue(`${name}Last`, reading);
    await device.setStoreValue(`${name}Offset`, newOffset);
    return round3(reading + newOffset);
  }
  device.falling.delete(name);
  if (typeof last.value === 'number' && reading < last.value) return round3(last.value + offset);
  if (reading !== last.value) {
    last.value = reading;
    // abs: a clock set back must not stop the saves
    if (Math.abs(Date.now() - last.savedAt) >= SAVE_INTERVAL) {
      last.savedAt = Date.now();
      await device.setStoreValue(`${name}Last`, reading);
    }
  }
  return round3(reading + offset);
}

/**
 * Continue a monotonic() counter on another source (e.g. more batteries added up) where it is now:
 * the next readings count from here, without a jump.
 * @param {Homey.Device} device
 * @param {string} name store key prefix, as for monotonic()
 * @param {number} reading the new source's counter
 * @param {string} [capability] as for monotonic()
 */
async function rebase(device, name, reading, capability = name) {
  const last = lastOf(device, name, capability);
  if (typeof last.value !== 'number') return;
  device.log(`${device.getName()} ${name} rebased from ${last.value} to ${reading}`);
  const offset = last.value + last.offset - reading;
  Object.assign(last, { value: reading, offset, savedAt: Date.now() });
  await device.setStoreValue(`${name}Offset`, offset);
  await device.setStoreValue(`${name}Last`, reading);
}

/** Store the last readings that monotonic() held back; for onUninit. */
async function saveCounters(device) {
  await Promise.all([...(device.counterLast || [])]
    .filter(([name, last]) => typeof last.value === 'number' && last.value !== device.getStoreValue(`${name}Last`))
    .map(([name, last]) => device.setStoreValue(`${name}Last`, last.value).catch((error) => device.error(error))));
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
  dateIn, monotonic, raiseListenerCeiling, rebase, saveCounters,
};

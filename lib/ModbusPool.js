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
 * Shared Modbus TCP helper. One file, kept identical (apart from the licence header) in
 * com.solarwatt, com.solaredge, com.foxess, com.growatt and com.sungrowpower so they cannot drift apart: change it
 * in every app at once.
 */

const ModbusClient = require('./ModbusClient');

/**
 * Reference-counted Modbus clients, one per host/port: every unit id on a server shares one socket
 * and one request queue (ModbusClient.forUnit), so the server sees a single connection.
 */
module.exports = class ModbusPool {

  constructor() {
    this.entries = new Map();
  }

  static key({ host, port }) {
    return `${host}:${port}`;
  }

  /**
   * Get (or create) the shared client for this server and take a reference on it for `unitId`.
   * Always pair with `release()` using the same parameters. The first caller's timeout and gap apply.
   * @returns {object} the client for `unitId` (readRegisters, writeRegister, writeRegisters)
   */
  acquire({
    host, port = 502, unitId = 1, timeout = 5000, gapMs = 0, log,
  }) {
    const key = ModbusPool.key({ host, port });
    let entry = this.entries.get(key);

    if (!entry) {
      entry = {
        client: new ModbusClient({
          host, port, unitId, timeout, gapMs, log,
        }),
        units: new Map(), // unit id -> references
      };
      this.entries.set(key, entry);
    }

    const unit = Number(unitId) || 1;
    entry.units.set(unit, (entry.units.get(unit) || 0) + 1);
    return entry.client.forUnit(unit);
  }

  /** Drop a reference, destroying the client once nothing on its server uses it any more. */
  release({ host, port = 502, unitId = 1 }) {
    const key = ModbusPool.key({ host, port });
    const entry = this.entries.get(key);
    if (!entry) return;

    const unit = Number(unitId) || 1;
    const refs = (entry.units.get(unit) || 0) - 1;
    if (refs > 0) entry.units.set(unit, refs);
    else entry.units.delete(unit);
    if (entry.units.size > 0) return;

    this.entries.delete(key);
    entry.client.destroy();
  }

  /** The endpoints with a client in use: { host, port, unitId }. */
  endpoints() {
    return [...this.entries.values()].flatMap(({ client, units }) => [...units.keys()]
      .map((unitId) => ({ host: client.host, port: client.port, unitId })));
  }

  /** Destroy every client. Used when the app shuts down. */
  destroy() {
    this.entries.forEach((entry) => entry.client.destroy());
    this.entries.clear();
  }

};

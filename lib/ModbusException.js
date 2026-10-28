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
 * com.solarwatt, com.solaredge, com.foxess and com.growatt so they cannot drift apart: change it
 * in every app at once.
 */

const EXCEPTION_MESSAGES = {
  0x01: 'Illegal function',
  0x02: 'Illegal data address',
  0x03: 'Illegal data value',
  0x04: 'Server device failure',
  0x05: 'Acknowledge',
  0x06: 'Server device busy',
  0x08: 'Memory parity error',
  0x0a: 'Gateway path unavailable',
  0x0b: 'Gateway target device failed to respond',
};

/** A Modbus server replied with an exception response instead of data. */
class ModbusException extends Error {

  constructor(code) {
    super(`Modbus exception 0x${code.toString(16).padStart(2, '0')}: ${EXCEPTION_MESSAGES[code] || 'Unknown'}`);
    this.name = 'ModbusException';
    this.code = code;
  }

}

module.exports = ModbusException;

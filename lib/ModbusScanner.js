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

const net = require('node:net');

/*
 * Finds hosts with an open TCP port on Homey's /24 subnet, after com.gruijter.otgw's BrokerScanner.
 * Only a connect: whether it is a device for the driver, a Modbus read by the driver decides.
 */

/** Resolves { host, port } when host:port accepts a connection within timeoutMs, else null. */
function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    // the socket idle timeout also runs while connecting
    socket.once('timeout', () => finish(null));
    socket.once('connect', () => finish({ host, port }));
    socket.once('error', () => finish(null));
  });
}

/**
 * The open ones of `ports` on every host of localIp's /24, all at once, by address.
 * @param {object} [options] { skipHosts }: addresses not to probe; { timeoutMs } per probe
 */
async function scan(localIp, ports, { skipHosts = [], timeoutMs = 1500 } = {}) {
  const prefix = localIp.split('.').slice(0, 3).join('.');
  const probes = [];
  for (let i = 1; i < 255; i += 1) {
    const host = `${prefix}.${i}`;
    if (skipHosts.includes(host)) continue;
    for (const port of ports) probes.push(probe(host, port, timeoutMs));
  }
  const found = (await Promise.all(probes)).filter(Boolean);
  return found.sort((a, b) => Number(a.host.split('.')[3]) - Number(b.host.split('.')[3]));
}

/**
 * A serial number of printable ASCII, to tell a scan hit from a Modbus server that answers any
 * address, e.g. with 0xFFFF everywhere (an SMA inverter, verified live).
 */
function plausibleSerial(serial) {
  return /^[\x21-\x7e]+$/.test(serial || '');
}

module.exports = { scan, probe, plausibleSerial };

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
 * What the shared Modbus layer (modbus_device.js, modbus_driver.js, registerCapture.js) differs in
 * per app: the point map of each Modbus driver, the "Get status update" event and the capture tag.
 */

const growatt = require('./growattModbusPointMap');

module.exports = {
  // driver id -> point map definition
  pointMap: {
    inverter_modbus: growatt.inverter,
    battery_modbus: growatt.battery,
    meter_modbus: growatt.meter,
  },
  // emitted by the app's force_poll Flow card, next to the cloud devices' poll
  pollEvent: 'modbusPoll',
  captureTag: 'GROWATT-MODBUS',
};

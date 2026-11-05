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

const ModbusDevice = require('../../lib/modbus_device');

module.exports = class GrowattBatteryModbusDevice extends ModbusDevice {

  /** The 'Set SoC limits' Flow card (app.js); its arguments are 0-100. */
  async setSocLimits({ min, max }) {
    await this.setControl({ battery_min_soc: min / 100, battery_max_soc: max / 100 });
  }

};

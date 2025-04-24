/*
Copyright 2025, Robin de Gruijter (rmdegruijter@gmail.com)

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

const Device = require('../../common_device');

module.exports = class MyDevice extends Device {

  async onInit() {
    await super.onInit();
  }

  async handleDeviceData(device) {
    // check if data is new
    if (!device || !device.historyLast || device.historyLast.createTime === this.lastCreateTime) return;
    await this.setAvailable();
    this.lastPoll = Date.now();
    this.lastCreateTime = device.historyLast.createTime;
    const values = {
      measure_power: (device.historyLast.pacToUserTotal ?? 0) - (device.historyLast.pacToGridTotal ?? 0),
      measure_frequency: device.historyLast.fac,
      'measure_voltage.1': device.historyLast.vac1,
      'measure_voltage.2': device.historyLast.vac2,
      'measure_voltage.3': device.historyLast.vac3,
      'meter_power.imported': device.historyLast.etoUserTotal ?? 0,
      'meter_power.exported': (device.historyLast.etoGridTotal || device.historyLast.etogridTotal) ?? 0,
      meter_power: (device.historyLast.etoUserTotal ?? 0) - (device.historyLast.etoGridTotal ?? 0),
    };
    // set the capability values
    for (const [capability, value] of Object.entries(values)) {
      this.setCapability(capability, value).catch((error) => this.error(error));
    }
    // set settings that have changed
    const newSettings = {
      plantId: device.deviceData.plantId,
      plantName: device.deviceData.plantName,
    };
    for (const [key, value] of Object.entries(newSettings)) this.setSetting(key, value);
  }

};

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
    const meterToday = (device.historyLast.epv1Today ?? 0) + (device.historyLast.epv2Today ?? 0) + (device.historyLast.epv3Today ?? 0) + (device.historyLast.epv4Today ?? 0);
    const values = {
      measure_power: device.historyLast.ppv,
      meter_power: device.historyLast.epvTotal,
      'meter_power.today': meterToday,
      // 'meter_power.month': Number(device.deviceData.eMonth),
    };
    // set the capability values
    for (const [capability, value] of Object.entries(values)) {
      this.setCapability(capability, value).catch((error) => this.error(error));
    }
    // set settings that have changed
    const newSettings = {
      type: device.deviceData.deviceTypeName,
      model: device.deviceData.deviceModel,
      serial: device.deviceData.sn,
      nominalPower: device.deviceData.nominalPower,
      dataLogger: device.deviceData.datalogSn,
      plantId: device.deviceData.plantId,
      plantName: device.deviceData.plantName,
    };
    for (const [key, value] of Object.entries(newSettings)) this.setSetting(key, value);
  }

};

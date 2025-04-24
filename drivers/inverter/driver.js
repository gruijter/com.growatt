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

const Homey = require('homey');

module.exports = class MyDriver extends Homey.Driver {

  async onInit() {
    this.log('Growatt driver has been initialized');
  }

  async onPair(session) {
    let username = '';
    let password = '';
    let info = false;

    session.setHandler('login', async (data) => {
      try {
        username = data.username;
        password = data.password;
        info = await this.homey.app.pollAccount({ username, password });
        return Promise.resolve(info);
      } catch (error) {
        const msg = error.message && error.message.includes('"msg":') ? JSON.parse(error.message).msg : error;
        this.error(error);
        return Promise.reject(msg);
      }
    });

    session.setHandler('list_devices', async () => {
      this.log(JSON.stringify(info));
      const PVInverters = info.filter((device) => device.historyLast && (device.historyLast.ppv || device.historyLast.epvTotal));
      const devices = PVInverters.map((device) => ({
        name: `PV_${device.deviceData.plantName}`,
        data: {
          id: device.deviceData.sn,
        },
        capabilities: [
          'measure_power',
          'meter_power',
          'meter_power.today',
          // 'meter_power.month',
        ],
        settings: {
          username,
          password,
          type: device.deviceData.deviceTypeName,
          model: device.deviceData.deviceModel,
          serial: device.deviceData.sn,
          nominalPower: device.deviceData.nominalPower,
          dataLogger: device.deviceData.datalogSn,
          plantId: device.deviceData.plantId,
          plantName: device.deviceData.plantName,
        },
      }));
      return Promise.all(devices);
    });
  }

};

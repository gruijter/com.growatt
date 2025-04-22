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

const Growatt = require('growatt');

module.exports = class MyDriver extends Homey.Driver {

  async onInit() {
    this.api = new Growatt();
    this.log('Growatt driver has been initialized');
  }

  async onPair(session) {
    let username = '';
    let password = '';
    let info = false;

    session.setHandler('login', async (data) => {
      username = data.username;
      password = data.password;
      return this.api.login(username, password).catch(this.error);
    });

    session.setHandler('list_devices', async () => {
      const options = {
        // plantId: '',
        // plantData: false,
        // deviceData: false,
        // deviceTyp: false,
        // weather: false,
        faultlog: true,
        // totalData: false,
        // statusData: false,
        // historyLast: false,
        // historyAll: false,
        // chartLastArray: false,
      };
      info = await this.api.getAllPlantData(options);
      this.log(JSON.stringify(info));
      // const flattenObject = (obj, parent = '', res = {}) => {
      //   Object.keys(obj).forEach((key) => {
      //     const propName = parent ? `${parent}.${key}` : key;
      //     if (typeof obj[key] === 'object' && obj[key] !== null) {
      //       flattenObject(obj[key], propName, res);
      //     } else {
      //       res[propName] = obj[key];
      //     }
      //   });
      //   return res;
      // };
      // const flattenedInfo = flattenObject(info);
      // this.log('Flattened info:', flattenedInfo);
      // console.dir(info, { depth: null });

      const plantArray = Object.entries(info).map(([plantId, plantObject]) => ({ ...plantObject }));
      const deviceList = plantArray.flatMap((plant) => Object.entries(plant.devices).map(([deviceName, deviceObject]) => ({ ...deviceObject })));
      const inverters = deviceList
        // .filter((device) => ['tlxh'].includes(device.growattType)) // 'inverter', 'inv', 'tlx',
        .filter((device) => device.historyLast && (device.historyLast.fac || device.historyLast.pacToGridTotal || device.historyLast.etoGridTotal));

      const devices = inverters.map((device) => ({
        name: `Meter ${device.deviceData.plantName}`,
        data: {
          id: `${device.deviceData.sn}`,
        },
        capabilities: [
          'measure_power',
          'meter_power',
          'measure_frequency',
          'measure_voltage.1',
          'measure_voltage.2',
          'measure_voltage.3',
          'meter_power.imported',
          'meter_power.exported',
        ],
        settings: {
          username,
          password,
          interval: 5,
          // type: device.deviceData.deviceTypeName,
          // model: device.deviceData.deviceModel,
          // serial: device.deviceData.sn,
          // nominalPower: device.deviceData.nominalPower,
          // dataLogger: device.deviceData.datalogSn,
          plantId: device.deviceData.plantId,
          plantName: device.deviceData.plantName,
        },
      }));
      return Promise.all(devices);
    });
  }

};

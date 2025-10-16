/* eslint-disable camelcase */
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
const growattMap = require('./lib/growattMap');
const Api = require('./lib/growatt');

module.exports = class MyDriver extends Homey.Driver {

  async onInit() {
    this.log(`${this.id} driver has been initialized`);
  }

  async onPair(session) {
    let username = '';
    let token = '';
    let info = false;
    let growatt = null;

    session.setHandler('login', async (data) => {
      try {
        username = data.username;
        token = data.password;
        growatt = new Api({ user_name: username, token });
        info = await growatt.getPlantListUser();
        return Promise.resolve(info);
      } catch (error) {
        const msg = error.message && error.message.includes('"message":') ? JSON.parse(error.message).message : error;
        this.error(error);
        return Promise.reject(msg);
      }
    });

    session.setHandler('list_devices', async () => {
      this.log(JSON.stringify(info));
      if (!growatt) throw Error('Growatt api not created');
      const validTypes = Object.keys(growattMap[`${this.id}Map`]);
      const sites = info?.plants || [];
      const devices = [];
      for (const site of sites) {
        // get device data
        // const deviceList1 = await growatt.getDeviceList({ plant_id: site.plant_id }).catch(this.error);
        const deviceList2 = await growatt.getDeviceList2({ plant_id: site.plant_id }).catch((error) => {
          this.error(error);
          let err = error;
          if (err.message && err.message.toUpperCase().includes('FREQUENTLY_ACCESS')) err = new Error('Wait at least 5 minutes before retrying');
          throw err;
        });
        // console.dir(deviceList2, { depth: null });
        const list = deviceList2?.data;
        if (!list || !Array.isArray(list)) continue;
        // add devices as Homey device when it is a valid type
        for (const dev of list) {
          if (validTypes.includes(dev.deviceType)) {
            // const devInfo = await growatt.getDeviceInfo({ deviceSn: dev.deviceSn, deviceType: dev.deviceType }).catch(this.error);
            // const dev1 = deviceList1?.devices?.find((d) => d.device_sn === dev.deviceSn);
            // console.log(dev1);
            const capabilities = Object.keys(growattMap[`${this.id}Map`][dev.deviceType]);
            const device = {
              name: `${site.name} ${dev.deviceSn}`,
              data: {
                id: dev.deviceSn,
              },
              capabilities,
              settings: {
                username,
                token,
                deviceType: `${dev.deviceType}`,
                deviceSn: `${dev.deviceSn}`,
                dataLogger: `${dev.datalogSn}`,
                // model: `${dev1?.model}`,
                plantId: `${site.plant_id}`,
                plantName: `${site.name}`,
                // deviceId: `${dev1?.device_id}`,
                // deviceTypeNr: `${dev1?.type}`,
                // nominalPower: `${devInfo?.pmax}` || '',
              },
            };
            devices.push(device);
          }
        }
      }
      this.log(devices);
      return Promise.all(devices);
    });
  }

  // poll one or multiple plants from one client
  async pollPlants({ client, psIdList, pointIdList }) {
    try {
      // console.log('pollPlants called', psIdList, pointIdList);
      const data = await client.getPlantRealTimeData({ psIdList, pointIdList });
      const plantInfo = data?.result_data?.device_point_list || [];
      return Promise.resolve(plantInfo);
    } catch (error) {
      this.error(error);
      return Promise.reject(error);
    }
  }

  // poll one or multiple devices from one client
  async pollDeviceType({
    client,
    psKeyList,
    pointIdList,
    deviceType,
  }) {
    try {
      if (deviceType === 'plant') throw new Error('Device type "plant" should not be used in pollDeviceType, use pollPlants instead');
      // console.log('pollDevices called', deviceType, psKeyList, pointIdList);
      // deviceData
      const data = await client.getDeviceRealTimeData({ deviceType, psKeyList, pointIdList });
      const deviceInfo = data?.result_data?.device_point_list || [];
      return Promise.resolve(deviceInfo);
    } catch (error) {
      this.error(error);
      return Promise.reject(error);
    }
  }

};

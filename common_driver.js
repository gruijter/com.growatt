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
        info = await growatt.getPlantListUser().catch(this.error);
        if (!info) {
          const userInfo = await growatt.checkUser();
          let errorMessage = '';
          if (!userInfo.userNameExists) errorMessage = 'User does not exist';
          errorMessage = 'API Problem. Please contact service.nl@growatt.com to fix your account';
          throw Error(errorMessage);
        }
        return info;
      } catch (error) {
        this.error(error);
        throw error.message || error;
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
        const deviceList2 = await growatt.getDeviceList2({ plant_id: site.plant_id });
        // console.dir(deviceList2, { depth: null });
        const list = deviceList2?.data;
        if (!list || !Array.isArray(list)) continue;
        // add devices as Homey device when it is a valid type
        for (const dev of list) {
          if (validTypes.includes(dev.deviceType)) {
            // const devInfo = await growatt.getDeviceInfo({ deviceSn: dev.deviceSn, deviceType: dev.deviceType }).catch(this.error);
            // console.log(devInfo);

            // set the capablities based on growattMap
            const caps = Object.keys(growattMap[`${this.id}Map`][dev.deviceType]);
            let capabilities = [...caps];
            // remove fake second battery capabilities
            if (this.id === 'battery2') capabilities = capabilities.filter((cap) => !cap.includes('.bat2'));

            // add device
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

            // add second battery device
            if (this.id === 'battery2') {
              const lastData = await this.homey.app.pollDevice({
                username, token, deviceSn: dev.deviceSn, deviceType: dev.deviceType,
              }).catch(() => this.error);
              if (lastData) {
                const thisDeviceTypeData = lastData[dev.deviceType] || [];
                const devData = thisDeviceTypeData.filter((d) => d.serialNum === dev.deviceSn)[0];
                if (devData && Object.keys(devData).some((d) => d.startsWith('bdc2'))) {
                  const device = {
                    name: `${site.name} ${dev.deviceSn}_2`,
                    data: {
                      id: `${dev.deviceSn}.bat2`,
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

          }
        }
      }
      this.log(devices);
      return devices;
    });
  }

  // // poll one or multiple plants from one client
  // async pollPlants({ client, psIdList, pointIdList }) {
  //   try {
  //     // console.log('pollPlants called', psIdList, pointIdList);
  //     const data = await client.getPlantRealTimeData({ psIdList, pointIdList });
  //     const plantInfo = data?.result_data?.device_point_list || [];
  //     return Promise.resolve(plantInfo);
  //   } catch (error) {
  //     return Promise.reject(error.message || error);
  //   }
  // }

  // // poll one or multiple devices from one client
  // async pollDeviceType({
  //   client,
  //   psKeyList,
  //   pointIdList,
  //   deviceType,
  // }) {
  //   try {
  //     if (deviceType === 'plant') throw new Error('Device type "plant" should not be used in pollDeviceType, use pollPlants instead');
  //     // console.log('pollDevices called', deviceType, psKeyList, pointIdList);
  //     // deviceData
  //     const data = await client.getDeviceRealTimeData({ deviceType, psKeyList, pointIdList });
  //     const deviceInfo = data?.result_data?.device_point_list || [];
  //     return Promise.resolve(deviceInfo);
  //   } catch (error) {
  //     return Promise.reject(error.message || error);
  //   }
  // }

};

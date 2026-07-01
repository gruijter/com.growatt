/* eslint-disable camelcase */
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

const Homey = require('homey');
const growattMap = require('./growattMap');
const Api = require('./growatt_api');

module.exports = class MyDriver extends Homey.Driver {

  async onInit() {
    this.log(`${this.id} driver has been initialized`);
  }

  async onPair(session) {
    let username = '';
    let token = '';
    let info = false;
    let growatt = null;
    let foundDevices = [];

    session.setHandler('login', async (data) => {
      try {
        username = data.username;
        token = data.password;
        const discovery = await Api.discoverHost({ username, token, log: (msg) => this.log(msg) });
        info = discovery.info;
        this.selectedHost = discovery.host;
        growatt = this.homey.app.getSession({ username, token, host: this.selectedHost });

        // Pre-fetch devices now while the spinner is visible on the credentials screen
        const validTypes = Object.keys(growattMap[`${this.id}Map`]);
        const sites = info?.plants || [];
        const firstSite = sites[0] || {};
        const devices = [];
        const addedSns = new Set();

        // 1. Get device list for the entire account to obtain deviceType strings
        const deviceList2 = await growatt.getDeviceList2({});
        const list = deviceList2?.data;

        const allDevices = {};
        if (list && Array.isArray(list)) {
          for (const dev of list) {
            if (!dev.deviceSn && dev.serialNum) dev.deviceSn = dev.serialNum;
            if (!dev.deviceSn && dev.inverterId) dev.deviceSn = dev.inverterId;
            if (!dev.deviceSn && dev.mixSn) dev.deviceSn = dev.mixSn;
            if (!dev.deviceSn && dev.spaSn) dev.deviceSn = dev.spaSn;
            if (!dev.deviceSn && dev.hpsSn) dev.deviceSn = dev.hpsSn;
            if (!dev.deviceSn && dev.tlxSn) dev.deviceSn = dev.tlxSn;
            if (!dev.deviceSn && dev.maxSn) dev.deviceSn = dev.maxSn;
            if (!dev.deviceSn && dev.pcsSn) dev.deviceSn = dev.pcsSn;
            const sn = dev.deviceSn;
            if (sn) {
              allDevices[sn] = dev;
            }
          }
        }

        // Helper function to build device objects
        const createDeviceObject = async (dev, site) => {
          // Set power limits to 0. They will be fetched automatically during device initialization in common_device.js
          const nominalPower = 0;
          const maxChargePower = 0;
          const maxDischargePower = 0;

          // set the capablities based on growattMap
          const caps = Object.keys(growattMap[`${this.id}Map`][dev.deviceType]);
          let capabilities = [...caps];
          // remove fake second battery capabilities
          if (this.id === 'battery2') capabilities = capabilities.filter((cap) => !cap.includes('.bat2'));

          // prepare base device
          const device = {
            name: `${site.name || dev.deviceType.toUpperCase()} ${dev.deviceSn}`,
            data: {
              id: dev.deviceSn,
            },
            capabilities,
            settings: {
              username,
              token,
              host: this.selectedHost || 'openapi.growatt.com',
              deviceType: `${dev.deviceType}`,
              deviceSn: `${dev.deviceSn}`,
              dataLogger: `${dev.datalogSn}`,
              plantId: `${site.plant_id || ''}`,
              plantName: `${site.name || ''}`,
              nominalPower,
              maxChargePower,
              maxDischargePower,
            },
          };

          let hasBat1 = true;
          let hasBat2 = false;

          // Check for actual battery presence if driver is battery2
          if (this.id === 'battery2') {
            hasBat1 = false;
            const lastData = await growatt.getLastData({
              deviceSn: dev.deviceSn, deviceType: dev.deviceType,
            }).catch((e) => {
              this.error(e);
              return null;
            });
            if (lastData) {
              const thisDeviceTypeData = lastData[dev.deviceType] || [];
              const devData = thisDeviceTypeData.find((d) => (d.serialNum || d.deviceSn) === dev.deviceSn);
              if (devData) {
                // A battery is considered present if it has a >0 value for SoC or Charge Totals
                hasBat1 = Number(devData.soc || 0) > 0
                          || Number(devData.capacity || 0) > 0
                          || Number(devData.bdc1Soc || 0) > 0
                          || Number(devData.totalBatteryPackSoc || 0) > 0
                          || Number(devData.bdc1ChargeTotal || 0) > 0
                          || Number(devData.eChargeTotal || 0) > 0
                          || Number(devData.echarge1Total || 0) > 0;

                hasBat2 = Number(devData.bdc2Soc || 0) > 0
                          || Number(devData.bdc2ChargeTotal || 0) > 0
                          || Number(devData.bdc2DischargeTotal || 0) > 0;
              }
            }
          }

          if (hasBat1 || this.id !== 'battery2') {
            devices.push(device);
          }

          if (this.id === 'battery2' && hasBat2) {
            const device2 = {
              name: `${site.name || dev.deviceType.toUpperCase()} ${dev.deviceSn}_2`,
              data: {
                id: `${dev.deviceSn}.bat2`,
              },
              capabilities,
              settings: {
                username,
                token,
                host: this.selectedHost || 'openapi.growatt.com',
                deviceType: `${dev.deviceType}`,
                deviceSn: `${dev.deviceSn}`,
                dataLogger: `${dev.datalogSn}`,
                plantId: `${site.plant_id || ''}`,
                plantName: `${site.name || ''}`,
                nominalPower,
                maxChargePower,
                maxDischargePower,
              },
            };
            devices.push(device2);
          }
        };

        // 2. Loop through all plants to map them
        for (const site of sites) {
          let v1Devices = [];
          try {
            const deviceList = await growatt.getDeviceList({ plant_id: site.plant_id });
            v1Devices = deviceList?.devices || [];
          } catch (err) {
            this.error(`Failed to get device list for plant ${site.plant_id}`, err.message || err);
          }

          for (const v1Dev of v1Devices) {
            const sn = v1Dev.device_sn || v1Dev.deviceSn;
            if (sn && allDevices[sn]) {
              const dev = allDevices[sn];
              if (validTypes.includes(dev.deviceType) && !addedSns.has(sn)) {
                addedSns.add(sn);
                await createDeviceObject(dev, site);
              }
            }
          }
        }

        // 3. Fallback for unmapped devices
        for (const [sn, dev] of Object.entries(allDevices)) {
          if (validTypes.includes(dev.deviceType) && !addedSns.has(sn)) {
            addedSns.add(sn);
            await createDeviceObject(dev, firstSite);
          }
        }

        foundDevices = devices;
        return info;
      } catch (error) {
        this.error(error);
        throw error.message || error;
      }
    });

    session.setHandler('list_devices', async () => {
      this.log('Returning pre-fetched devices:', foundDevices);
      return foundDevices;
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

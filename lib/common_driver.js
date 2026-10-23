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
const capture = require('./growattCapture');

module.exports = class MyDriver extends Homey.Driver {

  async onInit() {
    this.log(`${this.id} driver has been initialized`);
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  async onPair(session) {
    let username = '';
    let token = '';
    let info = false;
    let growatt = null;
    let foundDevices = [];

    session.setHandler('login', async (data) => {
      try {
        capture.arm(`pairing ${this.id}`, { force: true });
        username = data.username;
        token = data.password;
        const discovery = await Api.discoverHost({
          username, token, homey: this.homey, log: (msg) => this.log(msg),
        });
        info = discovery.info;
        this.selectedHost = discovery.host;
        growatt = this.homey.app.getSession({ username, token, host: this.selectedHost });

        // fetched while the login screen shows its spinner
        const validTypes = Object.keys(growattMap[`${this.id}Map`]);
        const sites = info?.plants || [];
        const firstSite = sites[0] || {};
        const devices = [];
        const addedSns = new Set();

        const deviceList2 = await growatt.getDeviceList2({});
        const list = deviceList2?.data;

        const allDevices = {};
        if (list && Array.isArray(list)) {
          for (const dev of list) {
            if (!dev.deviceSn) dev.deviceSn = growattMap.deviceSnOf(dev);
            const sn = dev.deviceSn;
            if (sn) {
              allDevices[sn] = dev;
            }
          }
        }

        // one call per device type (up to 100 serials each), so pairing fits the dialog's timeout
        const payloads = new Map();
        const infos = new Map();
        {
          const snsByType = {};
          Object.values(allDevices).forEach((d) => {
            if (!validTypes.includes(d.deviceType)) return;
            snsByType[d.deviceType] = [...(snsByType[d.deviceType] || []), d.deviceSn];
          });
          for (const [deviceType, sns] of Object.entries(snsByType)) {
            // Only these two depend on the battery verdict. A rate limit is shown to the user; any
            // other failure leaves the verdict unknown and the devices are offered anyway.
            if (this.id === 'battery2' || this.id === 'inverter2') {
              const lastData = await growatt.getLastData({ deviceSn: sns.join(','), deviceType })
                .catch((e) => {
                  if (e && e.reason === 'RATE_LIMITED') throw e;
                  this.error(e);
                  return null;
                });
              ((lastData && lastData[deviceType]) || []).forEach((entry) => {
                const sn = growattMap.deviceSnOf(entry);
                if (sn) payloads.set(sn, entry);
              });
            }

            // rated power and model at pairing, so target_power gets its real range at once
            const info = await growatt.getDeviceInfo({ deviceSn: sns.join(','), deviceType })
              .catch((e) => {
                this.error(e);
                return null;
              });
            ((info && info[deviceType]) || []).forEach((entry) => {
              const sn = growattMap.deviceSnOf(entry);
              if (sn) infos.set(sn, entry);
            });
          }
        }

        const createDeviceObject = async (dev, site) => {
          const info = infos.get(dev.deviceSn) || {};
          const nominalPower = Number(info.pmax || info.nominalPower || 0);
          const maxChargePower = Number(info.maxChargePower || info.chargePower || nominalPower || 0);
          const maxDischargePower = Number(info.maxDischargePower || info.dischargePower || nominalPower || 0);
          const model = growattMap.deviceModel(info, dev.deviceSn);

          // The payload settles the battery verdict before pairing, so the device gets its final
          // capability set and needs no migration on first init.
          const devData = payloads.get(dev.deviceSn) || null;

          const hasBattery = this.id === 'inverter2' && devData
            ? growattMap.hasBatteryHistory(devData)
            : undefined;
          const capsSource = this.id === 'inverter2'
            ? growattMap.inverterCapabilities(dev.deviceType, hasBattery)
            : growattMap[`${this.id}Map`][dev.deviceType];
          const capabilities = Object.keys(capsSource);

          const device = {
            name: `${site.name || dev.deviceType.toUpperCase()} ${dev.deviceSn}`,
            data: {
              id: dev.deviceSn,
            },
            capabilities,
            ...(capabilities.includes('target_power')
              ? {
                capabilitiesOptions: {
                  target_power: growattMap.targetPowerOptions(this.id, {
                    nominalPower, maxChargePower, maxDischargePower, deviceType: dev.deviceType, model,
                  }),
                },
              }
              : {}),
            // null: not determined
            store: { hasBattery: hasBattery === undefined ? null : hasBattery },
            settings: {
              username,
              token,
              host: this.selectedHost || 'openapi.growatt.com',
              deviceType: `${dev.deviceType}`,
              deviceSn: `${dev.deviceSn}`,
              dataLogger: `${dev.datalogSn}`,
              plantId: `${site.plant_id || ''}`,
              plantName: `${site.name || ''}`,
              model: model || '',
              ...(growattMap.usesPowerSettings(this.id)
                ? { nominalPower, maxChargePower, maxDischargePower }
                : {}),
            },
          };

          let hasBat1 = true;
          if (this.id === 'battery2') {
            hasBat1 = !!devData && (Number(devData.soc || 0) > 0
                        || Number(devData.capacity || 0) > 0
                        || Number(devData.bdc1Soc || 0) > 0
                        || Number(devData.totalBatteryPackSoc || 0) > 0
                        || Number(devData.bdc1ChargeTotal || 0) > 0
                        || Number(devData.eChargeTotal || 0) > 0
                        || Number(devData.echarge1Total || 0) > 0);
          }

          // one battery device per unit (growattMap.js#batteryMap)
          if (hasBat1 || this.id !== 'battery2') {
            devices.push(device);
          }
        };

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

        // devices not found under a plant
        for (const [sn, dev] of Object.entries(allDevices)) {
          if (validTypes.includes(dev.deviceType) && !addedSns.has(sn)) {
            addedSns.add(sn);
            await createDeviceObject(dev, firstSite);
          }
        }

        const skipped = Object.values(allDevices).filter((dev) => !validTypes.includes(dev.deviceType));
        if (skipped.length) {
          this.log(`Pairing ${this.id}: skipped ${skipped.map((dev) => `${dev.deviceSn} (${dev.deviceType})`).join(', ')}: type not supported by this driver`);
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

  // Repair: a new API token or username for this device, checked against the account like pairing.
  onRepair(session, device) {
    session.setHandler('login', async (data) => {
      try {
        capture.arm(`repair ${this.id}`, { force: true });
        const { username, password: token } = data;
        const { host } = await Api.discoverHost({
          username, token, homey: this.homey, log: (msg) => this.log(msg),
        });
        const growatt = this.homey.app.getSession({ username, token, host });
        const list = (await growatt.getDeviceList2({}))?.data;
        const { deviceSn, deviceType } = device.getSettings();
        const listedType = growattMap.listedDeviceType(list, deviceSn);
        if (!listedType) throw Error(this.homey.__('errors.deviceNotOnAccount'));
        const settings = { username, token, host };
        // a device Growatt moved to another type: follow it, and let the new type's data decide the rest
        if (listedType !== deviceType && growattMap[`${this.id}Map`][listedType]) {
          this.log(`Repair: ${device.getName()} moves from '${deviceType}' to '${listedType}'`);
          Object.assign(settings, { deviceType: listedType, model: '' });
          await device.setStoreValue('hasBattery', null);
          await device.setStoreValue('deviceInfoAt', 0);
          await device.setStoreValue('rebaseCounters', listedType);
        }
        this.log(`Repair: new credentials for ${device.getName()} on ${host}`);
        await device.setSettings(settings);
        // the new schedule polls at once, so start it only after the device listens again
        device.restartDevice(1000)
          .then(() => this.homey.app.everyXminutesHandler())
          .catch((error) => this.error(error));
        return true;
      } catch (error) {
        this.error(error);
        throw error.message || error;
      }
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

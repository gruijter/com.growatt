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
        const discovery = await Api.discoverHost({
          username, token, homey: this.homey, log: (msg) => this.log(msg),
        });
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
            if (!dev.deviceSn) dev.deviceSn = growattMap.deviceSnOf(dev);
            const sn = dev.deviceSn;
            if (sn) {
              allDevices[sn] = dev;
            }
          }
        }

        // One lastData call per device TYPE, not per device. queryLastData accepts up to 100
        // serials, so a five-device account costs one call instead of five. That matters because
        // pairing runs inside Homey's dialog while every call to one account is spaced three
        // seconds apart: per device it came to twelve serialised calls, about 33 seconds, which is
        // past the point where the dialog gives up. Per type it is eight, about 21.
        const payloads = new Map();
        const infos = new Map();
        {
          const snsByType = {};
          Object.values(allDevices).forEach((d) => {
            if (!validTypes.includes(d.deviceType)) return;
            snsByType[d.deviceType] = [...(snsByType[d.deviceType] || []), d.deviceSn];
          });
          for (const [deviceType, sns] of Object.entries(snsByType)) {
            // A check that could not be RUN is not a check that found no battery. Swallowing the
            // difference is what made an account with a working battery (bdc1Soc 19,
            // bdc1ChargeTotal 4584) offer nothing to pair at all. A rate-limit refusal is
            // transient and the user can act on it, so let that one surface as a message; any
            // other failure leaves the payloads unknown and the devices are offered anyway.
            // Only the drivers whose capability set depends on a battery verdict need the
            // measurements; meter2 needs the rated power and model below just the same.
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

            // Rated power and model too, for the same reason and at the same price: one grouped
            // call. Leaving them to be written on first init cost a restart of every freshly
            // paired device, because `model` is a settings change and only power limits are
            // exempt from restarting (common_device#onSettings) - and until then target_power
            // carried a fallback maximum of 3000 W instead of the real one.
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

        // Helper function to build device objects
        const createDeviceObject = async (dev, site) => {
          // Settled here from the prefetched device info, not left at 0 for first init to discover
          const info = infos.get(dev.deviceSn) || {};
          const nominalPower = Number(info.pmax || info.nominalPower || 0);
          const maxChargePower = Number(info.maxChargePower || info.chargePower || nominalPower || 0);
          const maxDischargePower = Number(info.maxDischargePower || info.dischargePower || nominalPower || 0);
          const model = growattMap.deviceModel(info, dev.deviceSn);

          // The payload decides two things about a device, so fetch it BEFORE building the device
          // rather than after: whether a battery2 has a battery at all, and - for inverter2 -
          // whether this is a hybrid with battery history or a plain string inverter, which have
          // different capability sets. Determining that here is what keeps a freshly paired device
          // out of "waiting for migration": otherwise pairing hands over the full hybrid set, the
          // first poll settles the verdict, and common_device#migrate rebuilds on the way back up.
          // The call is free in practice - the client caches it for five minutes, so pairing a
          // second driver on the same account reuses it, and so does the device's own first poll.
          const devData = payloads.get(dev.deviceSn) || null;

          // set the capablities based on growattMap
          const hasBattery = this.id === 'inverter2' && devData
            ? growattMap.hasBatteryHistory(devData)
            : undefined;
          const capsSource = this.id === 'inverter2'
            ? growattMap.inverterCapabilities(dev.deviceType, hasBattery)
            : growattMap[`${this.id}Map`][dev.deviceType];
          let capabilities = Object.keys(capsSource);
          // remove fake second battery capabilities
          if (this.id === 'battery2') capabilities = capabilities.filter((cap) => !cap.includes('.bat2'));

          // prepare base device
          const device = {
            name: `${site.name || dev.deviceType.toUpperCase()} ${dev.deviceSn}`,
            data: {
              id: dev.deviceSn,
            },
            capabilities,
            // migrate() treats a target_power options change as a migration and restarts the
            // device for it. The manifest defaults never match a real inverter's rated power, so
            // without this every freshly paired device restarted once on its first init - the last
            // of the three separate causes behind "waiting for migration" right after pairing.
            ...(capabilities.includes('target_power')
              ? { capabilitiesOptions: { target_power: growattMap.targetPowerOptions(this.id, { nominalPower, maxChargePower, maxDischargePower }) } }
              : {}),
            // The same verdict capabilityMap() reads, stored now rather than discovered on the
            // first poll - so migrate() finds nothing to rebuild and handleLastData finds nothing
            // to restart for. null means "not determined", which capabilityMap treats as unknown.
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
          let hasBat2 = false;

          // Check for actual battery presence if driver is battery2
          if (this.id === 'battery2') {
            hasBat1 = false;
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
              ...(capabilities.includes('target_power')
                ? { capabilitiesOptions: { target_power: growattMap.targetPowerOptions(this.id, { nominalPower, maxChargePower, maxDischargePower }) } }
                : {}),
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

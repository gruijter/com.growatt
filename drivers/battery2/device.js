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

const Device = require('../../lib/common_device');

module.exports = class MyDevice extends Device {

  // a second battery device ('<sn>.bat2', paired before one device per unit) was never a real battery
  get isMergedBattery() {
    return String(this.getData().id).endsWith('.bat2');
  }

  async onInit() {
    if (this.isMergedBattery) {
      this.restarting = false;
      this.log(`${this.getName()} is a second battery device; the unit's batteries are one device now`);
      await this.setUnavailable(this.homey.__('status.batteryMerged')).catch((error) => this.error(error));
      // clear its last (junk bdc2) readings from Homey Energy
      for (const cap of ['measure_power', 'measure_battery']) {
        if (this.hasCapability(cap)) await this.setCapabilityValue(cap, null).catch((error) => this.error(error));
      }
      return;
    }
    await super.onInit();
  }

  async onAdded() {
    if (this.isMergedBattery) return;
    await super.onAdded();
  }

  async onSettings(event) {
    if (this.isMergedBattery) return;
    await super.onSettings(event);
  }

};

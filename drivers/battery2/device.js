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
const growattMap = require('../../lib/growattMap');

// Additional BMS telemetry exposed by MIX/SPH lastData. Kept here instead of
// changing the shared map so battery-specific enrichment stays isolated to
// the battery2 driver. Object.assign is idempotent and runs before the common
// device migration, so existing Homey devices receive the capabilities
// dynamically without requiring re-pairing.
const sphBmsMap = {
  measure_battery_soh: ['getLastData', (data) => Number(data.bmsSOH)],
  measure_battery_cycles: ['getLastData', (data) => Number(data.bmsCycleCnt)],
  measure_voltage_battery: ['getLastData', (data) => Number(data.vbat ?? data.bmsBatteryVolt ?? data.vBatDsp)],
  measure_current_battery: ['getLastData', (data) => Number(data.bmsBatteryCurr)],
  measure_temperature_battery: ['getLastData', (data) => Number(data.batteryTemperature)],
  measure_temperature_bms: ['getLastData', (data) => Number(data.bmsBatteryTemp)],
  measure_voltage_cell_min: ['getLastData', (data) => Number(data.minSingleCellVolt)],
  measure_voltage_cell_max: ['getLastData', (data) => Number(data.maxSingleCellVolt)],
  measure_voltage_cell_delta: ['getLastData', (data) => {
    const min = Number(data.minSingleCellVolt);
    const max = Number(data.maxSingleCellVolt);
    return Number.isFinite(min) && Number.isFinite(max) ? Number((max - min).toFixed(3)) : null;
  }],
  measure_temperature_cell_min: ['getLastData', (data) => Number(data.minSingleCellTem)],
  measure_temperature_cell_max: ['getLastData', (data) => Number(data.maxSingleCellTem)],
  measure_current_charge_limit: ['getLastData', (data) => Number(data.bmsMaxCurr)],
  measure_current_discharge_limit: ['getLastData', (data) => Number(data.bmsMaxDischgCurr)],
  alarm_battery_charge_forbidden: ['getLastData', (data) => Number(data.chargeForbiddenMark ?? 0) === 1],
  alarm_battery_discharge_forbidden: ['getLastData', (data) => Number(data.dischargeForbiddenMark ?? 0) === 1],
  alarm_bms_error: ['getLastData', (data) => (
    Number(data.bmsError ?? 0) !== 0
    || Number(data.bmsError2 ?? 0) !== 0
    || Number(data.bmsError3 ?? 0) !== 0
    || Number(data.bmsProtection ?? 0) !== 0
    || Number(data.batErrorUnion ?? 0) !== 0
    || Number(data.faultCode ?? 0) !== 0
    || Number(data.errorCode ?? 0) !== 0
    || Number(data.warnCode ?? 0) !== 0
  )],
};

module.exports = class MyDevice extends Device {

  async onInit() {
    if (growattMap.battery2Map?.sph) Object.assign(growattMap.battery2Map.sph, sphBmsMap);
    await super.onInit();
  }

};

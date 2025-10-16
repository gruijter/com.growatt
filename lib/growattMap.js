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

// inv (Description: Inverter)
// storage
// max
// sph
// spa
// min
// wit
// sph-s
// noah

// ShinePhone
// https://openapi.growatt.com/login

// Docs:
// https://www.showdoc.com.cn/2598832417617967/11558377939801334

// Postman:
// https://www.postman.com/gold-water-163355/growatt-public/overview

// homey_capability: [ get conversion, set conversion ]

const batteryMap = {
  inv: {
    measure_power: [(data) => Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0))], // Battery Charging Power - Battery Discharging Power W
    measure_battery: [(data) => Number(data.bdc1Soc)], // SoC bat1 %
    'meter_power.charged': [(data) => Number(data.bdc1ChargeTotal)], // Battery Charging Energy kWh
    'meter_power.discharged': [(data) => Number(data.bdc1DischargeTotal)], // Battery Discharging Energy kWh
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })], // max power 0 - 100 %
  },
  storage: {
    measure_power: [(data) => Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0))],
    measure_battery: [(data) => Number(data.bdc1Soc)],
    'meter_power.charged': [(data) => Number(data.bdc1ChargeTotal)],
    'meter_power.discharged': [(data) => Number(data.bdc1DischargeTotal)],
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })],
  },
  max: {
    measure_power: [(data) => Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0))],
    measure_battery: [(data) => Number(data.bdc1Soc)],
    'meter_power.charged': [(data) => Number(data.bdc1ChargeTotal)],
    'meter_power.discharged': [(data) => Number(data.bdc1DischargeTotal)],
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })],
  },
  sph: {
    measure_power: [(data) => Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0))],
    measure_battery: [(data) => Number(data.bdc1Soc)],
    'meter_power.charged': [(data) => Number(data.bdc1ChargeTotal)],
    'meter_power.discharged': [(data) => Number(data.bdc1DischargeTotal)],
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })],
  },
  spa: {
    measure_power: [(data) => Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0))],
    measure_battery: [(data) => Number(data.bdc1Soc)],
    'meter_power.charged': [(data) => Number(data.bdc1ChargeTotal)],
    'meter_power.discharged': [(data) => Number(data.bdc1DischargeTotal)],
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })],
  },
  min: {
    measure_power: [(data) => Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0))],
    measure_battery: [(data) => Number(data.bdc1Soc)],
    'meter_power.charged': [(data) => Number(data.bdc1ChargeTotal)],
    'meter_power.discharged': [(data) => Number(data.bdc1DischargeTotal)],
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })],
  },
  wit: {
    measure_power: [(data) => Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0))],
    measure_battery: [(data) => Number(data.bdc1Soc)],
    'meter_power.charged': [(data) => Number(data.bdc1ChargeTotal)],
    'meter_power.discharged': [(data) => Number(data.bdc1DischargeTotal)],
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })],
  },
  'sph-s': {
    measure_power: [(data) => Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0))],
    measure_battery: [(data) => Number(data.bdc1Soc)],
    'meter_power.charged': [(data) => Number(data.bdc1ChargeTotal)],
    'meter_power.discharged': [(data) => Number(data.bdc1DischargeTotal)],
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })],
  },
  noah: {
    measure_power: [(data) => Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0))],
    measure_battery: [(data) => Number(data.bdc1Soc)],
    'meter_power.charged': [(data) => Number(data.bdc1ChargeTotal)],
    'meter_power.discharged': [(data) => Number(data.bdc1DischargeTotal)],
    'dim.active_power': [(val) => Number(val) / 800, (val) => ({ call: 'setActivePower', value: Math.round(800 * Number(val)) })], // max power 0 - 100 % @ 800 W
  },
};

// device last data
const inverterMap = {
  // plant: {
  //   measure_power: (data) => Number(data.current_power), // Plant Power W
  //   meter_power: (data) => Number(data.total_energy), // Plant total yield
  //   'meter_power.today': (data) => Number(data.today_energy), // Plant daily yield
  // },
  inv: {
    measure_power: [(data) => Number(data.ppv)], // Total Power W
    meter_power: [(data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': [(data) => Number((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0))], // Today Yield kWh
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })], // max power 0 - 100 %
  },
  storage: {
    measure_power: [(data) => Number(data.ppv)], // Total Power W
    meter_power: [(data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': [(data) => Number((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0))], // Today Yield kWh
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })], // max power 0 - 100 %
  },
  max: {
    measure_power: [(data) => Number(data.ppv)], // Total Power W
    meter_power: [(data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': [(data) => Number((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0))], // Today Yield kWh
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })], // max power 0 - 100 %
  },
  sph: {
    measure_power: [(data) => Number(data.ppv)], // Total Power W
    meter_power: [(data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': [(data) => Number((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0))], // Today Yield kWh
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })], // max power 0 - 100 %
  },
  spa: {
    measure_power: [(data) => Number(data.ppv)], // Total Power W
    meter_power: [(data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': [(data) => Number((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0))], // Today Yield kWh
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })], // max power 0 - 100 %
  },
  min: {
    measure_power: [(data) => Number(data.ppv)], // Total Power W
    meter_power: [(data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': [(data) => Number((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0))], // Today Yield kWh
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })], // max power 0 - 100 %
  },
  wit: {
    measure_power: [(data) => Number(data.ppv)], // Total Power W
    meter_power: [(data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': [(data) => Number((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0))], // Today Yield kWh
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })], // max power 0 - 100 %
  },
  'sph-s': {
    measure_power: [(data) => Number(data.ppv)], // Total Power W
    meter_power: [(data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': [(data) => Number((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0))], // Today Yield kWh
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })], // max power 0 - 100 %
  },
  noah: {
    measure_power: [(data) => Number(data.ppv)], // Total Power W
    meter_power: [(data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': [(data) => Number((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0))], // Today Yield kWh
    'dim.active_power': [(val) => Number(val) / 800, (val) => ({ call: 'setActivePower', value: Math.round(800 * Number(val)) })], // max power 0 - 100 % @ 800 W
  },
};

const meterMap = {
  inv: {
    measure_power: [(data) => Number((data.pacToUserTotal ?? 0) - (data.pacToGridTotal ?? 0))], // Power from grid - power to grid (W)
    meter_power: [(data) => Number((data.eselfTotal ?? 0) - (data.esystemTotal ?? 0))], // total energy from grid - total energy to grid (kWh)
    measure_frequency: [(data) => Number(data.fac)], // Frequency
    'measure_voltage.1': [(data) => Number(data.vac1)], // Voltage Phase 1 V
    'measure_voltage.2': [(data) => Number(data.vac2)], // Voltage Phase 2 V
    'measure_voltage.3': [(data) => Number(data.vac3)], // Voltage Phase 3 V
    'meter_power.imported': [(data) => Number(data.eselfTotal ?? 0)], // Total Energy imported from grid kWh
    'meter_power.exported': [(data) => Number(data.esystemTotal ?? 0)], // Total Energy exported to grid
  },
  storage: {
    measure_power: [(data) => Number((data.pacToUserTotal ?? 0) - (data.pacToGridTotal ?? 0))],
    meter_power: [(data) => Number((data.eselfTotal ?? 0) - (data.esystemTotal ?? 0))],
    measure_frequency: [(data) => Number(data.fac)],
    'measure_voltage.1': [(data) => Number(data.vac1)],
    'measure_voltage.2': [(data) => Number(data.vac2)],
    'measure_voltage.3': [(data) => Number(data.vac3)],
    'meter_power.imported': [(data) => Number(data.eselfTotal ?? 0)],
    'meter_power.exported': [(data) => Number(data.esystemTotal ?? 0)],
  },
  max: {
    measure_power: [(data) => Number((data.pacToUserTotal ?? 0) - (data.pacToGridTotal ?? 0))],
    meter_power: [(data) => Number((data.eselfTotal ?? 0) - (data.esystemTotal ?? 0))],
    measure_frequency: [(data) => Number(data.fac)],
    'measure_voltage.1': [(data) => Number(data.vac1)],
    'measure_voltage.2': [(data) => Number(data.vac2)],
    'measure_voltage.3': [(data) => Number(data.vac3)],
    'meter_power.imported': [(data) => Number(data.eselfTotal ?? 0)],
    'meter_power.exported': [(data) => Number(data.esystemTotal ?? 0)],
  },
  sph: {
    measure_power: [(data) => Number((data.pacToUserTotal ?? 0) - (data.pacToGridTotal ?? 0))],
    meter_power: [(data) => Number((data.eselfTotal ?? 0) - (data.esystemTotal ?? 0))],
    measure_frequency: [(data) => Number(data.fac)],
    'measure_voltage.1': [(data) => Number(data.vac1)],
    'measure_voltage.2': [(data) => Number(data.vac2)],
    'measure_voltage.3': [(data) => Number(data.vac3)],
    'meter_power.imported': [(data) => Number(data.eselfTotal ?? 0)],
    'meter_power.exported': [(data) => Number(data.esystemTotal ?? 0)],
  },
  spa: {
    measure_power: [(data) => Number((data.pacToUserTotal ?? 0) - (data.pacToGridTotal ?? 0))],
    meter_power: [(data) => Number((data.eselfTotal ?? 0) - (data.esystemTotal ?? 0))],
    measure_frequency: [(data) => Number(data.fac)],
    'measure_voltage.1': [(data) => Number(data.vac1)],
    'measure_voltage.2': [(data) => Number(data.vac2)],
    'measure_voltage.3': [(data) => Number(data.vac3)],
    'meter_power.imported': [(data) => Number(data.eselfTotal ?? 0)],
    'meter_power.exported': [(data) => Number(data.esystemTotal ?? 0)],
  },
  min: {
    measure_power: [(data) => Number((data.pacToUserTotal ?? 0) - (data.pacToGridTotal ?? 0))],
    meter_power: [(data) => Number((data.eselfTotal ?? 0) - (data.esystemTotal ?? 0))],
    measure_frequency: [(data) => Number(data.fac)],
    'measure_voltage.1': [(data) => Number(data.vac1)],
    'measure_voltage.2': [(data) => Number(data.vac2)],
    'measure_voltage.3': [(data) => Number(data.vac3)],
    'meter_power.imported': [(data) => Number(data.eselfTotal ?? 0)],
    'meter_power.exported': [(data) => Number(data.esystemTotal ?? 0)],
  },
  wit: {
    measure_power: [(data) => Number((data.pacToUserTotal ?? 0) - (data.pacToGridTotal ?? 0))],
    meter_power: [(data) => Number((data.eselfTotal ?? 0) - (data.esystemTotal ?? 0))],
    measure_frequency: [(data) => Number(data.fac)],
    'measure_voltage.1': [(data) => Number(data.vac1)],
    'measure_voltage.2': [(data) => Number(data.vac2)],
    'measure_voltage.3': [(data) => Number(data.vac3)],
    'meter_power.imported': [(data) => Number(data.eselfTotal ?? 0)],
    'meter_power.exported': [(data) => Number(data.esystemTotal ?? 0)],
  },
  'sph-s': {
    measure_power: [(data) => Number((data.pacToUserTotal ?? 0) - (data.pacToGridTotal ?? 0))],
    meter_power: [(data) => Number((data.eselfTotal ?? 0) - (data.esystemTotal ?? 0))],
    measure_frequency: [(data) => Number(data.fac)],
    'measure_voltage.1': [(data) => Number(data.vac1)],
    'measure_voltage.2': [(data) => Number(data.vac2)],
    'measure_voltage.3': [(data) => Number(data.vac3)],
    'meter_power.imported': [(data) => Number(data.eselfTotal ?? 0)],
    'meter_power.exported': [(data) => Number(data.esystemTotal ?? 0)],
  },
  noah: {
    measure_power: [(data) => Number((data.pacToUserTotal ?? 0) - (data.pacToGridTotal ?? 0))],
    meter_power: [(data) => Number((data.eselfTotal ?? 0) - (data.esystemTotal ?? 0))],
    measure_frequency: [(data) => Number(data.fac)],
    'measure_voltage.1': [(data) => Number(data.vac1)],
    'measure_voltage.2': [(data) => Number(data.vac2)],
    'measure_voltage.3': [(data) => Number(data.vac3)],
    'meter_power.imported': [(data) => Number(data.eselfTotal ?? 0)],
    'meter_power.exported': [(data) => Number(data.esystemTotal ?? 0)],
  },
};

const nonLastDataMap = {
  'dim.active_power': 'getActivePower',
};

module.exports = {
  inverterMap, meterMap, batteryMap, nonLastDataMap,
};

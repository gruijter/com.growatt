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

// ShinePhone web login: https://openapi.growatt.com/login
// API Docs: https://www.showdoc.com.cn/2598832417617967
// Postman collection: https://www.postman.com/gold-water-163355/growatt-public/overview

// homey_capability: [ get conversion, set conversion ]

const batteryMap = {
  // inv: {
  //   measure_power: [(data) => Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0))], // Battery Charging Power - Battery Discharging Power W
  //   measure_battery: [(data) => Number(data.bdc1Soc)], // SoC bat1 %
  //   'meter_power.charged': [(data) => Number(data.bdc1ChargeTotal)], // Battery Charging Energy kWh
  //   'meter_power.discharged': [(data) => Number(data.bdc1DischargeTotal)], // Battery Discharging Energy kWh
  //   'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })], // max power 0 - 100 %
  // },

  storage: {
    measure_power: [(data) => Number((data.pcharge ?? 0) - (data.pdischarge ?? 0))],
    measure_battery: [(data) => Number(data.capacity)],
    'meter_power.charged': [(data) => Number(data.eChargeTotal)],
    'meter_power.discharged': [(data) => Number(data.eDischargeTotal)],
  },

  sph: {
    measure_power: [(data) => Number((data.pcharge1 ?? 0) - (data.pdischarge1 ?? 0))],
    measure_battery: [(data) => Number(data.soc)],
    'meter_power.charged': [(data) => Number(data.echarge1Total)],
    'meter_power.discharged': [(data) => Number(data.edischarge1Total)],
  },

  // max: {
  //   measure_power: [(data) => Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0))],
  //   measure_battery: [(data) => Number(data.bdc1Soc)],
  //   'meter_power.charged': [(data) => Number(data.bdc1ChargeTotal)],
  //   'meter_power.discharged': [(data) => Number(data.bdc1DischargeTotal)],
  //   'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })],
  // },

  spa: {
    measure_power: [(data) => Number((data.pcharge1 ?? 0) - (data.pdischarge1 ?? 0))],
    measure_battery: [(data) => Number(data.soc)],
    'meter_power.charged': [(data) => Number(data.echarge1Total)],
    'meter_power.discharged': [(data) => Number(data.edischarge1Total)],
  },

  min: {
    measure_power: [(data) => Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0))],
    measure_battery: [(data) => Number(data.bdc1Soc)],
    'meter_power.charged': [(data) => Number(data.bdc1ChargeTotal)],
    'meter_power.discharged': [(data) => Number(data.bdc1DischargeTotal)],
    battery_charging_state: [(data) => {
      const power = Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0));
      if (power > 0) return 'charging';
      if (power < 0) return 'discharging';
      return 'idle';
    }],
    // charge_setpoint: [(val) => Number(val), (val) => ({ call: 'setVPP', value: { setType: 'set_param_27', value: `${val}` } })],
    // charge_setpoint: [(val) => Number(val), (val) => ({ call: 'setChargeSetpoint', value: `${val}` })],
    'measure_power.bat2': [(data) => Number((data.bdc2ChargePower ?? 0) - (data.bdc2DischargePower ?? 0))],
    'measure_battery.bat2': [(data) => Number(data.bdc2Soc)],
    'meter_power.charged.bat2': [(data) => Number(data.bdc2ChargeTotal)],
    'meter_power.discharged.bat2': [(data) => Number(data.bdc2DischargeTotal)],
    'battery_charging_state.bat2': [(data) => {
      const power = Number((data.bdc2ChargePower ?? 0) - (data.bdc2DischargePower ?? 0));
      if (power > 0) return 'charging';
      if (power < 0) return 'discharging';
      return 'idle';
    }],
  },

  wit: {
    measure_power: [(data) => Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0))],
    measure_battery: [(data) => Number(data.bdc1Soc)],
    'meter_power.charged': [(data) => Number(data.bdc1ChargeTotal)],
    'meter_power.discharged': [(data) => Number(data.bdc1DischargeTotal)],
    battery_charging_state: [(data) => {
      const power = Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0));
      if (power > 0) return 'charging';
      if (power < 0) return 'discharging';
      return 'idle';
    }],
    'measure_power.bat2': [(data) => Number((data.bdc2ChargePower ?? 0) - (data.bdc2DischargePower ?? 0))],
    'measure_battery.bat2': [(data) => Number(data.bdc2Soc)],
    'meter_power.charged.bat2': [(data) => Number(data.bdc2ChargeTotal)],
    'meter_power.discharged.bat2': [(data) => Number(data.bdc2DischargeTotal)],
    'battery_charging_state.bat2': [(data) => {
      const power = Number((data.bdc2ChargePower ?? 0) - (data.bdc2DischargePower ?? 0));
      if (power > 0) return 'charging';
      if (power < 0) return 'discharging';
      return 'idle';
    }],
  },

  'sph-s': {
    measure_power: [(data) => Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0))],
    measure_battery: [(data) => Number(data.bdc1Soc)],
    'meter_power.charged': [(data) => Number(data.bdc1ChargeTotal)],
    'meter_power.discharged': [(data) => Number(data.bdc1DischargeTotal)],
    battery_charging_state: [(data) => {
      const power = Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0));
      if (power > 0) return 'charging';
      if (power < 0) return 'discharging';
      return 'idle';
    }],
    'measure_power.bat2': [(data) => Number((data.bdc2ChargePower ?? 0) - (data.bdc2DischargePower ?? 0))],
    'measure_battery.bat2': [(data) => Number(data.bdc2Soc)],
    'meter_power.charged.bat2': [(data) => Number(data.bdc2ChargeTotal)],
    'meter_power.discharged.bat2': [(data) => Number(data.bdc2DischargeTotal)],
    'battery_charging_state.bat2': [(data) => {
      const power = Number((data.bdc2ChargePower ?? 0) - (data.bdc2DischargePower ?? 0));
      if (power > 0) return 'charging';
      if (power < 0) return 'discharging';
      return 'idle';
    }],
  },

  noah: {
    measure_power: [(data) => {
      const power = Number(data.totalBatteryPackChargingPower);
      const status = Number(data.totalBatteryPackChargingStatus);
      if (status & 2) return -power;
      return power;
    }],
    measure_battery: [(data) => Number(data.totalBatteryPackSoc)],
    // 'meter_power.charged': [(data) => Number(data.echarge1Total)],
    // 'meter_power.discharged': [(data) => Number(data.edischarge1Total)],
    battery_charging_state: [(data) => {
      const status = Number(data.totalBatteryPackChargingStatus);
      if (status & 1) return 'charging';
      if (status & 2) return 'discharging';
      return 'idle';
    }],
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
    'meter_power.today': [(data) => Number(data.epvToday ?? ((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0)))], // Today Yield kWh
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })], // max power 0 - 100 %
  },
  storage: {
    measure_power: [(data) => Number(data.ppv)], // Total Power W
    meter_power: [(data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': [(data) => Number(data.epvToday ?? ((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0)))], // Today Yield kWh
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })], // max power 0 - 100 %
  },
  max: {
    measure_power: [(data) => Number(data.ppv)], // Total Power W
    meter_power: [(data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': [(data) => Number(data.epvToday ?? ((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0)))], // Today Yield kWh
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })], // max power 0 - 100 %
  },
  sph: {
    measure_power: [(data) => Number(data.ppv)], // Total Power W
    meter_power: [(data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': [(data) => Number(data.epvToday ?? ((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0)))], // Today Yield kWh
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })], // max power 0 - 100 %
  },
  spa: {
    measure_power: [(data) => Number(data.ppv)], // Total Power W
    meter_power: [(data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': [(data) => Number(data.epvToday ?? ((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0)))], // Today Yield kWh
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })], // max power 0 - 100 %
  },
  min: {
    measure_power: [(data) => Number(data.ppv)], // Total Power W
    meter_power: [(data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': [(data) => Number(data.epvToday ?? ((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0)))], // Today Yield kWh
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })], // max power 0 - 100 %
  },
  wit: {
    measure_power: [(data) => Number(data.ppv)], // Total Power W
    meter_power: [(data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': [(data) => Number(data.epvToday ?? ((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0)))], // Today Yield kWh
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })], // max power 0 - 100 %
  },
  'sph-s': {
    measure_power: [(data) => Number(data.ppv)], // Total Power W
    meter_power: [(data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': [(data) => Number(data.epvToday ?? ((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0)))], // Today Yield kWh
    'dim.active_power': [(val) => Number(val) / 100, (val) => ({ call: 'setActivePower', value: Math.round(100 * Number(val)) })], // max power 0 - 100 %
  },
  noah: {
    measure_power: [(data) => Number(data.ppv)], // Output Power W (BUCK)
    meter_power: [(data) => Number(data.eacTotal)], // Total Yield kWh
    'meter_power.today': [(data) => Number(data.eacToday)], // Today Yield kWh
    // 'dim.active_power': [(val) => Number(val) / 800, (val) => ({ call: 'setActivePower', value: Math.round(800 * Number(val)) })], // max power 0 - 100 % @ 800 W
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
  // noah: {
  //   measure_power: [(data) => Number((data.pacToUserTotal ?? 0) - (data.pacToGridTotal ?? 0))],
  //   meter_power: [(data) => Number((data.eselfTotal ?? 0) - (data.esystemTotal ?? 0))],
  //   measure_frequency: [(data) => Number(data.fac)],
  //   'measure_voltage.1': [(data) => Number(data.vac1)],
  //   'measure_voltage.2': [(data) => Number(data.vac2)],
  //   'measure_voltage.3': [(data) => Number(data.vac3)],
  //   'meter_power.imported': [(data) => Number(data.eselfTotal ?? 0)],
  //   'meter_power.exported': [(data) => Number(data.esystemTotal ?? 0)],
  // },
};

const nonLastDataMap = {
  'dim.active_power': 'getActivePower',
  // charge_setpoint: 'getChargeSetpoint',
};

module.exports = {
  inverter2Map: inverterMap, meter2Map: meterMap, battery2Map: batteryMap, nonLastDataMap,
};

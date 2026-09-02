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

// =========================================================
// HELPERS

// Helper to calculate Gross Solar AC output (accounting for battery charge/discharge)
const calcSolarAC = (pac, pcharge, pdischarge) => {
  const ac = Number(pac ?? 0);
  const charge = Number(pcharge ?? 0);
  const discharge = Number(pdischarge ?? 0);
  // To ensure Homey Energy sums perfectly: Net AC (pac) = Solar Yield - Battery Consumption
  // Where Battery Consumption = charge - discharge
  return Math.max(0, ac + charge - discharge);
};

// Grid meter energy counters. Growatt reports the grid connection as two one-way counters:
//   etoUser* = grid -> house  (imported)
//   etoGrid* = house -> grid  (exported)
// These are the counterparts of the pacToUser/pacToGrid instantaneous pair, and match input
// registers 31118-31124 in the VPP protocol ("power to user" / "power to grid").
// Do NOT use eself*/esystem* for this: eself is self-consumption and esystem is total system
// output, related by esystem = eself + etoGrid. Verified on two independent real 'min' payloads
// (esystemTotal - eselfTotal equalled etoGridTotal to 0.1 kWh in both), so eself/esystem carry no
// import information at all - reading them as import/export dropped grid import entirely and
// overstated both counters.
// The v1 API documents these as eToUserTotal/eToGridTotal for the 'storage' type while the v4
// payload for 'min' spells them etoUserTotal/etoGridTotal, so accept either spelling.
const num = (v) => (v === undefined || v === null ? undefined : Number(v));
const gridImported = (data) => num(data.etoUserTotal ?? data.eToUserTotal);
const gridExported = (data) => num(data.etoGridTotal ?? data.eToGridTotal);
// Net grid energy, import positive. Left undefined (capability untouched, rather than a bogus 0)
// when the device reports neither counter, e.g. a string inverter with no smart meter.
const gridNet = (data) => {
  const imported = gridImported(data);
  const exported = gridExported(data);
  if (imported === undefined && exported === undefined) return undefined;
  return (imported ?? 0) - (exported ?? 0);
};
// Net grid power, import positive. Same "leave alone when unreported" rule as gridNet().
// The 'storage' type is documented with the unsuffixed pacToUser/pacToGrid names (OpenAPI field
// table), so accept those as a fallback. Not verified against a live 'storage' device.
const gridPower = (data) => {
  const toUser = num(data.pacToUserTotal ?? data.pacToUser);
  const toGrid = num(data.pacToGridTotal ?? data.pacToGrid);
  if (toUser === undefined && toGrid === undefined) return undefined;
  return (toUser ?? 0) - (toGrid ?? 0);
};
// AC grid voltage per phase. The 'inv' device type names its phases vacr/vacs/vact instead of
// vac1/vac2/vac3 (confirmed against a live 'inv' payload and the OpenAPI field table), which left
// all three voltage capabilities permanently blank on those devices.
const acVoltage = (phase) => (data) => Number(data[`vac${phase}`] ?? data[['vacr', 'vacs', 'vact'][phase - 1]]);

// Helpers to convert between Homey's Target Power (Watts) and Growatt's Active Power (Percentage)
const getTargetPower = (val, settings) => Math.round((Number(val?.value ?? val) / 100) * Number(settings?.nominalPower || 3000));
const setTargetPower = (val, settings) => {
  const percentage = Math.round((Number(val) / Number(settings?.nominalPower || 3000)) * 100);
  // use setActivePower
  return {
    call: 'setActivePower',
    value: Math.max(0, Math.min(100, percentage)),
  };
};

// Helpers for Battery Target Power (Charge/Discharge)
// Growatt: +100% = max charge, -100% = max discharge
// Homey: negative = charging, positive = discharging
const getBatTargetPower = (val, settings) => {
  const pct = Number(val?.value ?? val) || 0;
  if (pct > 0) return Math.round(-(pct / 100) * Number(settings?.maxChargePower || settings?.nominalPower || 3000));
  return Math.round(-(pct / 100) * Number(settings?.maxDischargePower || settings?.nominalPower || 3000));
};
const setBatTargetPower = (val, settings) => {
  const power = Number(val);
  let percentage = 0;
  if (power < 0) {
    percentage = Math.round((-power / Number(settings?.maxChargePower || settings?.nominalPower || 3000)) * 100);
  } else if (power > 0) {
    percentage = Math.round((-power / Number(settings?.maxDischargePower || settings?.nominalPower || 3000)) * 100);
  }
  return {
    call: 'setChargePowerTarget',
    value: Math.max(-100, Math.min(100, percentage)),
  };
};

// =========================================================
// device capability mapping
// homey_capability: [ 'apiCall', get conversion, set conversion ]

const inverterMap = {
  inv: {
    measure_power: ['getLastData', (data) => Number(data.pac ?? data.ppv)], // AC Output from Solar
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', (data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': ['getLastData', (data) => Number(data.epvToday ?? ((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0)))], // Today Yield kWh
    target_power: ['getActivePower', getTargetPower, setTargetPower],
  },
  storage: {
    measure_power: ['getLastData', (data) => calcSolarAC(data.pac, data.pcharge, data.pdischarge)], // Gross Solar Yield
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', (data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': ['getLastData', (data) => Number(data.epvToday ?? ((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0)))], // Today Yield kWh
    'measure_power.ac_inverter': ['getLastData', (data) => Number(data.pac)],
    target_power: ['getActivePower', getTargetPower, setTargetPower],
  },
  max: {
    measure_power: ['getLastData', (data) => Number(data.pac ?? data.ppv)], // AC Output from Solar
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', (data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': ['getLastData', (data) => Number(data.epvToday ?? ((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0)))], // Today Yield kWh
    target_power: ['getActivePower', getTargetPower, setTargetPower],
  },
  sph: {
    measure_power: ['getLastData', (data) => calcSolarAC(data.pac, data.pcharge1, data.pdischarge1)], // Gross Solar Yield
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', (data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': ['getLastData', (data) => Number(data.epvToday ?? ((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0)))], // Today Yield kWh
    'measure_power.ac_inverter': ['getLastData', (data) => Number(data.pac)],
    target_power: ['getActivePower', getTargetPower, setTargetPower],
  },
  spa: {
    measure_power: ['getLastData', (data) => calcSolarAC(data.pac, data.pcharge1, data.pdischarge1)], // Gross Solar Yield
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', (data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': ['getLastData', (data) => Number(data.epvToday ?? ((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0)))], // Today Yield kWh
    'measure_power.ac_inverter': ['getLastData', (data) => Number(data.pac)],
    target_power: ['getActivePower', getTargetPower, setTargetPower],
  },
  min: {
    measure_power: ['getLastData', (data) => calcSolarAC(
      data.pac,
      Number(data.bdc1ChargePower ?? 0) + Number(data.bdc2ChargePower ?? 0),
      Number(data.bdc1DischargePower ?? 0) + Number(data.bdc2DischargePower ?? 0),
    )], // Gross Solar Yield
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', (data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': ['getLastData', (data) => Number(data.epvToday ?? ((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0)))], // Today Yield kWh
    'measure_power.ac_inverter': ['getLastData', (data) => Number(data.pac)],
    target_power: ['getActivePower', getTargetPower, setTargetPower],
  },
  wit: {
    measure_power: ['getLastData', (data) => calcSolarAC(
      data.pac,
      Number(data.bdc1ChargePower ?? 0) + Number(data.bdc2ChargePower ?? 0),
      Number(data.bdc1DischargePower ?? 0) + Number(data.bdc2DischargePower ?? 0),
    )], // Gross Solar Yield
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', (data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': ['getLastData', (data) => Number(data.epvToday ?? ((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0)))], // Today Yield kWh
    'measure_power.ac_inverter': ['getLastData', (data) => Number(data.pac)],
    target_power: ['getActivePower', getTargetPower, setTargetPower],
  },
  'sph-s': {
    measure_power: ['getLastData', (data) => calcSolarAC(
      data.pac,
      Number(data.bdc1ChargePower ?? 0) + Number(data.bdc2ChargePower ?? 0),
      Number(data.bdc1DischargePower ?? 0) + Number(data.bdc2DischargePower ?? 0),
    )], // Gross Solar Yield
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', (data) => Number(data.epvTotal)], // Total Yield kWh
    'meter_power.today': ['getLastData', (data) => Number(data.epvToday ?? ((data.epv1Today ?? 0) + (data.epv2Today ?? 0) + (data.epv3Today ?? 0) + (data.epv4Today ?? 0)))], // Today Yield kWh
    'measure_power.ac_inverter': ['getLastData', (data) => Number(data.pac)],
    target_power: ['getActivePower', getTargetPower, setTargetPower],
  },
  noah: {
    measure_power: ['getLastData', (data) => Number(data.pac ?? data.ppv)], // Output Power W (BUCK)
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', (data) => Number(data.eacTotal)], // Total Yield kWh
    'meter_power.today': ['getLastData', (data) => Number(data.eacToday)], // Today Yield kWh
    target_power: ['getActivePower', (val) => Number(val?.value ?? val), (val) => ({ call: 'setActivePower', value: String(Math.round(Number(val))) })], // Absolute Watts
  },
};

const meterMap = {
  inv: {
    measure_power: ['getLastData', gridPower], // Power from grid - power to grid (W)
    meter_power: ['getLastData', gridNet], // Total energy from grid - total energy to grid (kWh)
    measure_frequency: ['getLastData', (data) => Number(data.fac)], // Frequency
    'measure_voltage.1': ['getLastData', acVoltage(1)], // Voltage Phase 1 V
    'measure_voltage.2': ['getLastData', acVoltage(2)], // Voltage Phase 2 V
    'measure_voltage.3': ['getLastData', acVoltage(3)], // Voltage Phase 3 V
    'meter_power.imported': ['getLastData', gridImported], // Total Energy imported from grid kWh
    'meter_power.exported': ['getLastData', gridExported], // Total Energy exported to grid
  },
  storage: {
    measure_power: ['getLastData', gridPower],
    meter_power: ['getLastData', gridNet],
    measure_frequency: ['getLastData', (data) => Number(data.fac)],
    'measure_voltage.1': ['getLastData', acVoltage(1)],
    'measure_voltage.2': ['getLastData', acVoltage(2)],
    'measure_voltage.3': ['getLastData', acVoltage(3)],
    'meter_power.imported': ['getLastData', gridImported],
    'meter_power.exported': ['getLastData', gridExported],
  },
  max: {
    measure_power: ['getLastData', gridPower],
    meter_power: ['getLastData', gridNet],
    measure_frequency: ['getLastData', (data) => Number(data.fac)],
    'measure_voltage.1': ['getLastData', acVoltage(1)],
    'measure_voltage.2': ['getLastData', acVoltage(2)],
    'measure_voltage.3': ['getLastData', acVoltage(3)],
    'meter_power.imported': ['getLastData', gridImported],
    'meter_power.exported': ['getLastData', gridExported],
  },
  sph: {
    measure_power: ['getLastData', gridPower],
    meter_power: ['getLastData', gridNet],
    measure_frequency: ['getLastData', (data) => Number(data.fac)],
    'measure_voltage.1': ['getLastData', acVoltage(1)],
    'measure_voltage.2': ['getLastData', acVoltage(2)],
    'measure_voltage.3': ['getLastData', acVoltage(3)],
    'meter_power.imported': ['getLastData', gridImported],
    'meter_power.exported': ['getLastData', gridExported],
  },
  spa: {
    measure_power: ['getLastData', gridPower],
    meter_power: ['getLastData', gridNet],
    measure_frequency: ['getLastData', (data) => Number(data.fac)],
    'measure_voltage.1': ['getLastData', acVoltage(1)],
    'measure_voltage.2': ['getLastData', acVoltage(2)],
    'measure_voltage.3': ['getLastData', acVoltage(3)],
    'meter_power.imported': ['getLastData', gridImported],
    'meter_power.exported': ['getLastData', gridExported],
  },
  min: {
    measure_power: ['getLastData', gridPower],
    meter_power: ['getLastData', gridNet],
    measure_frequency: ['getLastData', (data) => Number(data.fac)],
    'measure_voltage.1': ['getLastData', acVoltage(1)],
    'measure_voltage.2': ['getLastData', acVoltage(2)],
    'measure_voltage.3': ['getLastData', acVoltage(3)],
    'meter_power.imported': ['getLastData', gridImported],
    'meter_power.exported': ['getLastData', gridExported],
  },
  wit: {
    measure_power: ['getLastData', gridPower],
    meter_power: ['getLastData', gridNet],
    measure_frequency: ['getLastData', (data) => Number(data.fac)],
    'measure_voltage.1': ['getLastData', acVoltage(1)],
    'measure_voltage.2': ['getLastData', acVoltage(2)],
    'measure_voltage.3': ['getLastData', acVoltage(3)],
    'meter_power.imported': ['getLastData', gridImported],
    'meter_power.exported': ['getLastData', gridExported],
  },
  'sph-s': {
    measure_power: ['getLastData', gridPower],
    meter_power: ['getLastData', gridNet],
    measure_frequency: ['getLastData', (data) => Number(data.fac)],
    'measure_voltage.1': ['getLastData', acVoltage(1)],
    'measure_voltage.2': ['getLastData', acVoltage(2)],
    'measure_voltage.3': ['getLastData', acVoltage(3)],
    'meter_power.imported': ['getLastData', gridImported],
    'meter_power.exported': ['getLastData', gridExported],
  },
  // noah: excluded because the balcony system sits strictly on the DC side and has no AC grid hardware for meter measurements.

};

const batteryMap = {
  // inv: excluded because pure grid-tied string inverters do not have a Battery Management System or BDC.

  storage: {
    measure_power: ['getLastData', (data) => Number((data.pcharge ?? 0) - (data.pdischarge ?? 0))],
    measure_battery: ['getLastData', (data) => Number(data.capacity)],
    'meter_power.charged': ['getLastData', (data) => Number(data.eChargeTotal)],
    'meter_power.discharged': ['getLastData', (data) => Number(data.eDischargeTotal)],
    battery_charging_state: ['getLastData', (data) => {
      const power = Number((data.pcharge ?? 0) - (data.pdischarge ?? 0));
      if (power > 0) return 'charging';
      if (power < 0) return 'discharging';
      return 'idle';
    }],
  },

  sph: {
    measure_power: ['getLastData', (data) => Number((data.pcharge1 ?? 0) - (data.pdischarge1 ?? 0))],
    measure_battery: ['getLastData', (data) => Number(data.soc)],
    'meter_power.charged': ['getLastData', (data) => Number(data.echarge1Total)],
    'meter_power.discharged': ['getLastData', (data) => Number(data.edischarge1Total)],
    battery_charging_state: ['getLastData', (data) => {
      const power = Number((data.pcharge1 ?? 0) - (data.pdischarge1 ?? 0));
      if (power > 0) return 'charging';
      if (power < 0) return 'discharging';
      return 'idle';
    }],
  },

  // max: excluded because commercial high-power string inverters do not have a Battery Management System or BDC.

  spa: {
    measure_power: ['getLastData', (data) => Number((data.pcharge1 ?? 0) - (data.pdischarge1 ?? 0))],
    measure_battery: ['getLastData', (data) => Number(data.soc)],
    'meter_power.charged': ['getLastData', (data) => Number(data.echarge1Total)],
    'meter_power.discharged': ['getLastData', (data) => Number(data.edischarge1Total)],
    battery_charging_state: ['getLastData', (data) => {
      const power = Number((data.pcharge1 ?? 0) - (data.pdischarge1 ?? 0));
      if (power > 0) return 'charging';
      if (power < 0) return 'discharging';
      return 'idle';
    }],
  },

  min: {
    measure_power: ['getLastData', (data) => Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0))],
    measure_battery: ['getLastData', (data) => Number(data.bdc1Soc)],
    'meter_power.charged': ['getLastData', (data) => Number(data.bdc1ChargeTotal)],
    'meter_power.discharged': ['getLastData', (data) => Number(data.bdc1DischargeTotal)],
    battery_charging_state: ['getLastData', (data) => {
      const power = Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0));
      if (power > 0) return 'charging';
      if (power < 0) return 'discharging';
      return 'idle';
    }],
    // target_power: ['getChargePowerTarget', getBatTargetPower, setBatTargetPower],
    'measure_power.bat2': ['getLastData', (data) => Number((data.bdc2ChargePower ?? 0) - (data.bdc2DischargePower ?? 0))],
    'measure_battery.bat2': ['getLastData', (data) => Number(data.bdc2Soc)],
    'meter_power.charged.bat2': ['getLastData', (data) => Number(data.bdc2ChargeTotal)],
    'meter_power.discharged.bat2': ['getLastData', (data) => Number(data.bdc2DischargeTotal)],
    'battery_charging_state.bat2': ['getLastData', (data) => {
      const power = Number((data.bdc2ChargePower ?? 0) - (data.bdc2DischargePower ?? 0));
      if (power > 0) return 'charging';
      if (power < 0) return 'discharging';
      return 'idle';
    }],
  },

  wit: {
    measure_power: ['getLastData', (data) => Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0))],
    measure_battery: ['getLastData', (data) => Number(data.bdc1Soc)],
    'meter_power.charged': ['getLastData', (data) => Number(data.bdc1ChargeTotal)],
    'meter_power.discharged': ['getLastData', (data) => Number(data.bdc1DischargeTotal)],
    battery_charging_state: ['getLastData', (data) => {
      const power = Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0));
      if (power > 0) return 'charging';
      if (power < 0) return 'discharging';
      return 'idle';
    }],
    'measure_power.bat2': ['getLastData', (data) => Number((data.bdc2ChargePower ?? 0) - (data.bdc2DischargePower ?? 0))],
    'measure_battery.bat2': ['getLastData', (data) => Number(data.bdc2Soc)],
    'meter_power.charged.bat2': ['getLastData', (data) => Number(data.bdc2ChargeTotal)],
    'meter_power.discharged.bat2': ['getLastData', (data) => Number(data.bdc2DischargeTotal)],
    'battery_charging_state.bat2': ['getLastData', (data) => {
      const power = Number((data.bdc2ChargePower ?? 0) - (data.bdc2DischargePower ?? 0));
      if (power > 0) return 'charging';
      if (power < 0) return 'discharging';
      return 'idle';
    }],
  },

  'sph-s': {
    measure_power: ['getLastData', (data) => Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0))],
    measure_battery: ['getLastData', (data) => Number(data.bdc1Soc)],
    'meter_power.charged': ['getLastData', (data) => Number(data.bdc1ChargeTotal)],
    'meter_power.discharged': ['getLastData', (data) => Number(data.bdc1DischargeTotal)],
    battery_charging_state: ['getLastData', (data) => {
      const power = Number((data.bdc1ChargePower ?? 0) - (data.bdc1DischargePower ?? 0));
      if (power > 0) return 'charging';
      if (power < 0) return 'discharging';
      return 'idle';
    }],
    'measure_power.bat2': ['getLastData', (data) => Number((data.bdc2ChargePower ?? 0) - (data.bdc2DischargePower ?? 0))],
    'measure_battery.bat2': ['getLastData', (data) => Number(data.bdc2Soc)],
    'meter_power.charged.bat2': ['getLastData', (data) => Number(data.bdc2ChargeTotal)],
    'meter_power.discharged.bat2': ['getLastData', (data) => Number(data.bdc2DischargeTotal)],
    'battery_charging_state.bat2': ['getLastData', (data) => {
      const power = Number((data.bdc2ChargePower ?? 0) - (data.bdc2DischargePower ?? 0));
      if (power > 0) return 'charging';
      if (power < 0) return 'discharging';
      return 'idle';
    }],
  },

  noah: {
    measure_power: ['getLastData', (data) => {
      const power = Number(data.totalBatteryPackChargingPower);
      const status = Number(data.totalBatteryPackChargingStatus);
      if (status & 2) return -power;
      return power;
    }],
    measure_battery: ['getLastData', (data) => Number(data.totalBatteryPackSoc)],
    // 'meter_power.charged': [(data) => Number(data.echarge1Total)],
    // 'meter_power.discharged': [(data) => Number(data.edischarge1Total)],
    battery_charging_state: ['getLastData', (data) => {
      const status = Number(data.totalBatteryPackChargingStatus);
      if (status & 1) return 'charging';
      if (status & 2) return 'discharging';
      return 'idle';
    }],
  },
};

// ==========================================================
module.exports = {
  inverter2Map: inverterMap, meter2Map: meterMap, battery2Map: batteryMap,
};

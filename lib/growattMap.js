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

// Device types: inv, storage, max, sph, spa, min, wit, sph-s, noah
// API docs: https://www.showdoc.com.cn/2598832417617967

// Battery-term efficiency when the live figure is unusable; the top of what these hybrids reach.
const FALLBACK_EFFICIENCY_PCT = 98;

// Gross solar AC output of a DC-coupled hybrid: solarAC = ppv * n = pac + (charge - discharge) * n.
// Only the battery term is converted, so a fallback efficiency cannot skew the measured pac.
const calcSolarAC = (pac, pcharge, pdischarge, efficiencyPct, ppv) => {
  const ac = Number(pac ?? 0);
  const charge = Number(pcharge ?? 0);
  const discharge = Number(pdischarge ?? 0);
  const usable = Number.isFinite(efficiencyPct) && efficiencyPct >= 50 && efficiencyPct <= 100;
  const eff = (usable ? efficiencyPct : FALLBACK_EFFICIENCY_PCT) / 100;
  const solarAC = Math.max(0, ac + (charge - discharge) * eff);
  // Capped at ppv * n: charging from the grid would otherwise count as solar (2 kW grid charge at
  // night showed ~1960 W). The cap is exactly inert while the battery charges from the panels,
  // which needs inverterEfficiency() at full precision. Skipped when ppv is not reported.
  const dc = (ppv === undefined || ppv === null) ? NaN : Number(ppv);
  if (!Number.isFinite(dc)) return solarAC;
  return Math.min(solarAC, Math.max(0, dc * eff));
};

const num = (v) => (v === undefined || v === null ? undefined : Number(v));

// lastData `status` meaning "fault" (OpenAPI 4.2.x tables; spa documents none). Doc-derived, never
// seen live. sysFaultWord* is not used: 66 was seen on a min in normal standby.
const FAULT_STATUS = {
  inv: 3, storage: 3, max: 3, wit: 3, min: 2, noah: 4,
};
// sph and sph-s: the docs' own examples contradict their tables (sph-s status 6 "Fault", sph
// status 5 "PV Bat Online"), so these go by statusText.
const FAULT_BY_TEXT = ['sph', 'sph-s'];
const inFault = (deviceType) => (data) => {
  if (FAULT_BY_TEXT.includes(deviceType)) {
    return typeof data.statusText === 'string' && data.statusText !== '' ? /fault/i.test(data.statusText) : undefined;
  }
  const status = num(data.status);
  if (!Number.isFinite(status)) return undefined;
  // noah faultStatus: BIT0..BIT3 = battery pack 1..4 fault
  return status === FAULT_STATUS[deviceType] || (deviceType === 'noah' && Number(data.faultStatus) > 0);
};
// etoUser* = grid -> house (imported), etoGrid* = house -> grid (exported); v1 'storage' spells
// them eTo*. Not eself*/esystem*: esystem = eself + etoGrid (verified on two min payloads).
const gridImported = (data) => num(data.etoUserTotal ?? data.eToUserTotal);
const gridExported = (data) => num(data.etoGridTotal ?? data.eToGridTotal);
// Net grid energy, import positive; undefined when neither counter is reported.
const gridNet = (data) => {
  const imported = gridImported(data);
  const exported = gridExported(data);
  if (imported === undefined && exported === undefined) return undefined;
  return (imported ?? 0) - (exported ?? 0);
};
// Net grid power, import positive. 'storage' is documented with unsuffixed names (not verified).
const gridPower = (data) => {
  const toUser = num(data.pacToUserTotal ?? data.pacToUser);
  const toGrid = num(data.pacToGridTotal ?? data.pacToGrid);
  if (toUser === undefined && toGrid === undefined) return undefined;
  return (toUser ?? 0) - (toGrid ?? 0);
};
// Per phase: vac1..3, 'inv' vacr/vacs/vact (confirmed live), 'storage' a single `vac` (doc only).
const acVoltage = (phase) => (data) => Number(data[`vac${phase}`]
  ?? data[['vacr', 'vacs', 'vact'][phase - 1]]
  ?? (phase === 1 ? data.vac : undefined));
// Per phase: iac1..3, 'inv' iacr/iacs/iact (both confirmed live).
const acCurrent = (phase) => (data) => Number(data[`iac${phase}`] ?? data[['iacr', 'iacs', 'iact'][phase - 1]]);

// target_power in W, Growatt active power in % of nominal power
const getTargetPower = (val, settings) => Math.round((Number(val?.value ?? val) / 100) * Number(settings?.nominalPower || 3000));
const setTargetPower = (val, settings) => {
  const percentage = Math.round((Number(val) / Number(settings?.nominalPower || 3000)) * 100);
  return {
    call: 'setActivePower',
    value: Math.max(0, Math.min(100, percentage)),
  };
};

// Battery target power. Growatt: +100% = max charge, -100% = max discharge.
// Homey: negative = charging, positive = discharging.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const getBatTargetPower = (val, settings) => {
  const pct = Number(val?.value ?? val) || 0;
  if (pct > 0) return Math.round(-(pct / 100) * Number(settings?.maxChargePower || settings?.nominalPower || 3000));
  return Math.round(-(pct / 100) * Number(settings?.maxDischargePower || settings?.nominalPower || 3000));
};
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

// Net battery DC power in W, positive while charging (a DC sink). Families name it disjointly:
// storage pcharge/pdischarge, sph/spa pcharge1/pdischarge1, min/wit/sph-s bdc1*, noah one signed field.
const batteryDcPower = (data) => {
  if (data.totalBatteryPackChargingPower !== undefined) { // noah
    return Number(data.totalBatteryPackChargingPower) || 0;
  }
  // bdc2* is junk on single-battery units (bdc2ChargeTotal aliases bdcBusRef / 10), so it is ignored
  const charge = Number(data.bdc1ChargePower ?? 0)
    + Number(data.pcharge ?? 0) + Number(data.pcharge1 ?? 0);
  const discharge = Number(data.bdc1DischargePower ?? 0)
    + Number(data.pdischarge ?? 0) + Number(data.pdischarge1 ?? 0);
  return charge - discharge;
};

// Whole-inverter efficiency in %: AC out / (PV + battery DC). Undefined (the tile keeps its last
// reading) when idle, below the DC floor, grid charging or outside 0-100%.
const inverterEfficiency = (data, settings) => {
  const pac = num(data.pac);
  const ppv = num(data.ppv);
  if (pac === undefined || ppv === undefined) return undefined;
  if (!(pac > 0)) return undefined; // idle or curtailed (noah while charging), not 0% efficient
  const dcIn = ppv - batteryDcPower(data);
  // below this, 0.1 A / 0.1 V quantisation and auxiliary draw dominate
  const floor = Math.max(50, Number(settings?.nominalPower || 0) * 0.02);
  if (dcIn < floor) return undefined;
  const pct = (pac / dcIn) * 100;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return undefined; // sampling skew, not a reading
  // full precision: calcSolarAC() relies on it, and "decimals" only affects display
  return pct;
};

// Solar yield in kWh. String inverters (inv/max): the AC counter (inv powerTotal, others eacTotal).
// Hybrids: the DC total, since their eacTotal leaves out PV into the battery and adds discharge.
const dcYieldTotal = (data) => num(data.epvTotal);
// epvToday only on 'storage', per-string epvNToday elsewhere; undefined when neither is reported
const dcYieldToday = (data) => {
  const direct = num(data.epvToday);
  if (direct !== undefined) return direct;
  const strings = [data.epv1Today, data.epv2Today, data.epv3Today, data.epv4Today]
    .map(num)
    .filter((v) => v !== undefined);
  if (strings.length === 0) return undefined;
  return strings.reduce((sum, v) => sum + v, 0);
};
const acYieldTotal = (data) => num(data.eacTotal) ?? num(data.powerTotal) ?? dcYieldTotal(data);
const acYieldToday = (data) => num(data.eacToday) ?? num(data.powerToday) ?? dcYieldToday(data);
// noah: eac* counts DC PV yield (no AC side; verified over a day of history: follows ppv, not pac)
const noahPvYieldTotal = (data) => num(data.eacTotal);
const noahPvYieldToday = (data) => num(data.eacToday);
// Hybrids: AC throughput including battery discharge, not solar yield
const inverterYieldTotal = (data) => num(data.eacTotal);

// Whether a hybrid ever used a battery, from lifetime counters so an idle battery still counts.
// Without one it is a string inverter and its AC counter is the solar yield. Undefined when the
// payload carries none of the fields. bdc2* only counts when a non-aliased field agrees: on a
// single-battery unit bdc2ChargeTotal is bdcBusRef / 10 (verified on two units).
const BATTERY_ENERGY_TOTALS = [
  'echargeTotal', 'eChargeTotal', 'edischargeTotal', 'eDischargeTotal', 'eacChargeTotal',
  'bdc1ChargeTotal', 'bdc1DischargeTotal', 'bmsSoc',
];
const BDC2_ENERGY_TOTALS = ['bdc2ChargeTotal', 'bdc2DischargeTotal'];
const BATTERY_CORROBORATION = ['echargeTotal', 'eChargeTotal', 'edischargeTotal', 'eDischargeTotal', 'bmsSoc'];
const readNumbers = (data, fields) => fields.map((field) => num(data[field])).filter((v) => v !== undefined);
const hasBatteryHistory = (data) => {
  const direct = readNumbers(data, BATTERY_ENERGY_TOTALS);
  const bdc2 = readNumbers(data, BDC2_ENERGY_TOTALS);
  if (direct.length === 0 && bdc2.length === 0) return undefined; // no battery fields at all
  if (direct.some((v) => v > 0)) return true;
  if (bdc2.some((v) => v > 0) && readNumbers(data, BATTERY_CORROBORATION).some((v) => v > 0)) return true;
  return false;
};

// Hybrid solar yield: DC, or AC without battery history (capabilityTitles.js titles it to match)
const solarYield = (data, hasBattery) => (hasBattery === false ? acYieldTotal(data) : dcYieldTotal(data));
const solarYieldTotal = (data) => solarYield(data, hasBatteryHistory(data));
const solarYieldToday = (data) => (hasBatteryHistory(data) === false ? acYieldToday(data) : dcYieldToday(data));

// homey_capability: [ 'apiCall', get conversion, set conversion ]

const inverterMap = {
  inv: {
    measure_power: ['getLastData', (data) => Number(data.pac ?? data.ppv)], // AC Output from Solar
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', acYieldTotal], // Total solar yield kWh (AC)
    'meter_power.today': ['getLastData', acYieldToday], // Today solar yield kWh (AC)
    target_power: ['getActivePower', getTargetPower, setTargetPower],
    'meter_power.dc_solar': ['getLastData', dcYieldTotal], // Total PV input kWh (DC)
    measure_efficiency: ['getLastData', inverterEfficiency],
    // confirmed live
    measure_temperature: ['getLastData', (data) => num(data.temperature)],
    alarm_problem: ['getLastData', inFault('inv')],
  },
  storage: {
    measure_power: ['getLastData', (data, settings) => calcSolarAC(
      data.pac, data.pcharge, data.pdischarge, inverterEfficiency(data, settings), data.ppv,
    )], // Gross Solar Yield
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', solarYieldTotal], // Total solar yield kWh (DC, or AC when no battery)
    'meter_power.today': ['getLastData', solarYieldToday], // Today solar yield kWh (DC, or AC when no battery)
    'measure_power.ac_inverter': ['getLastData', (data) => Number(data.pac)],
    target_power: ['getActivePower', getTargetPower, setTargetPower],
    'meter_power.ac_inverter': ['getLastData', inverterYieldTotal], // Inverter AC throughput kWh
    measure_efficiency: ['getLastData', inverterEfficiency],
    // doc-derived (OpenAPI 4.3.13), not verified
    measure_temperature: ['getLastData', (data) => num(data.temperature)],
    alarm_problem: ['getLastData', inFault('storage')],
  },
  max: {
    measure_power: ['getLastData', (data) => Number(data.pac ?? data.ppv)], // AC Output from Solar
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', acYieldTotal], // Total solar yield kWh (AC)
    'meter_power.today': ['getLastData', acYieldToday], // Today solar yield kWh (AC)
    target_power: ['getActivePower', getTargetPower, setTargetPower],
    'meter_power.dc_solar': ['getLastData', dcYieldTotal], // Total PV input kWh (DC)
    measure_efficiency: ['getLastData', inverterEfficiency],
    alarm_problem: ['getLastData', inFault('max')],
  },
  sph: {
    measure_power: ['getLastData', (data, settings) => calcSolarAC(
      data.pac, data.pcharge1, data.pdischarge1, inverterEfficiency(data, settings), data.ppv,
    )], // Gross Solar Yield
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', solarYieldTotal], // Total solar yield kWh (DC, or AC when no battery)
    'meter_power.today': ['getLastData', solarYieldToday], // Today solar yield kWh (DC, or AC when no battery)
    'measure_power.ac_inverter': ['getLastData', (data) => Number(data.pac)],
    target_power: ['getActivePower', getTargetPower, setTargetPower],
    'meter_power.ac_inverter': ['getLastData', inverterYieldTotal], // Inverter AC throughput kWh
    measure_efficiency: ['getLastData', inverterEfficiency],
    alarm_problem: ['getLastData', inFault('sph')],
  },
  spa: {
    measure_power: ['getLastData', (data, settings) => calcSolarAC(
      data.pac, data.pcharge1, data.pdischarge1, inverterEfficiency(data, settings), data.ppv,
    )], // Gross Solar Yield
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', solarYieldTotal], // Total solar yield kWh (DC, or AC when no battery)
    'meter_power.today': ['getLastData', solarYieldToday], // Today solar yield kWh (DC, or AC when no battery)
    'measure_power.ac_inverter': ['getLastData', (data) => Number(data.pac)],
    target_power: ['getActivePower', getTargetPower, setTargetPower],
    'meter_power.ac_inverter': ['getLastData', inverterYieldTotal], // Inverter AC throughput kWh
    measure_efficiency: ['getLastData', inverterEfficiency],
  },
  min: {
    measure_power: ['getLastData', (data, settings) => calcSolarAC(
      data.pac,
      // bdc2* is junk on single-battery units
      Number(data.bdc1ChargePower ?? 0),
      Number(data.bdc1DischargePower ?? 0),
      inverterEfficiency(data, settings),
      data.ppv,
    )], // Gross Solar Yield
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', solarYieldTotal], // Total solar yield kWh (DC, or AC when no battery)
    'meter_power.today': ['getLastData', solarYieldToday], // Today solar yield kWh (DC, or AC when no battery)
    'measure_power.ac_inverter': ['getLastData', (data) => Number(data.pac)],
    target_power: ['getActivePower', getTargetPower, setTargetPower],
    'meter_power.ac_inverter': ['getLastData', inverterYieldTotal], // Inverter AC throughput kWh
    measure_efficiency: ['getLastData', inverterEfficiency],
    // temp1 of temp1..temp5; which sensor is the inverter body is not documented (assumed)
    measure_temperature: ['getLastData', (data) => num(data.temp1)],
    alarm_problem: ['getLastData', inFault('min')],
  },
  wit: {
    measure_power: ['getLastData', (data, settings) => calcSolarAC(
      data.pac,
      // bdc2* is junk on single-battery units
      Number(data.bdc1ChargePower ?? 0),
      Number(data.bdc1DischargePower ?? 0),
      inverterEfficiency(data, settings),
      data.ppv,
    )], // Gross Solar Yield
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', solarYieldTotal], // Total solar yield kWh (DC, or AC when no battery)
    'meter_power.today': ['getLastData', solarYieldToday], // Today solar yield kWh (DC, or AC when no battery)
    'measure_power.ac_inverter': ['getLastData', (data) => Number(data.pac)],
    target_power: ['getActivePower', getTargetPower, setTargetPower],
    'meter_power.ac_inverter': ['getLastData', inverterYieldTotal], // Inverter AC throughput kWh
    measure_efficiency: ['getLastData', inverterEfficiency],
    alarm_problem: ['getLastData', inFault('wit')],
  },
  'sph-s': {
    measure_power: ['getLastData', (data, settings) => calcSolarAC(
      data.pac,
      // bdc2* is junk on single-battery units
      Number(data.bdc1ChargePower ?? 0),
      Number(data.bdc1DischargePower ?? 0),
      inverterEfficiency(data, settings),
      data.ppv,
    )], // Gross Solar Yield
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', solarYieldTotal], // Total solar yield kWh (DC, or AC when no battery)
    'meter_power.today': ['getLastData', solarYieldToday], // Today solar yield kWh (DC, or AC when no battery)
    'measure_power.ac_inverter': ['getLastData', (data) => Number(data.pac)],
    target_power: ['getActivePower', getTargetPower, setTargetPower],
    'meter_power.ac_inverter': ['getLastData', inverterYieldTotal], // Inverter AC throughput kWh
    measure_efficiency: ['getLastData', inverterEfficiency],
    alarm_problem: ['getLastData', inFault('sph-s')],
  },
  // noah is a DC-DC converter feeding a micro-inverter: measure_power is the panels, the converter
  // output (battery discharge included) has its own capability
  noah: {
    measure_power: ['getLastData', (data) => Number(data.ppv)], // Solar power (DC), panels only
    'measure_power.dc_converter': ['getLastData', (data) => Number(data.pac ?? data.ppv)], // Converter output to the micro-inverter, battery discharge included
    meter_power: ['getLastData', noahPvYieldTotal], // Total solar yield kWh (DC)
    'meter_power.today': ['getLastData', noahPvYieldToday], // Today solar yield kWh (DC)
    target_power: ['getActivePower', (val) => Number(val?.value ?? val), (val) => ({ call: 'setActivePower', value: String(Math.round(Number(val))) })], // Absolute Watts
    measure_efficiency: ['getLastData', inverterEfficiency],
    // confirmed live
    measure_temperature: ['getLastData', (data) => num(data.systemTemp)],
    alarm_problem: ['getLastData', inFault('noah')],
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
    'measure_current.1': ['getLastData', acCurrent(1)],
    'measure_current.2': ['getLastData', acCurrent(2)],
    'measure_current.3': ['getLastData', acCurrent(3)],
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
    'measure_current.1': ['getLastData', acCurrent(1)],
    'measure_current.2': ['getLastData', acCurrent(2)],
    'measure_current.3': ['getLastData', acCurrent(3)],
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
  // noah: no AC grid side

};

// Battery state of health in %. 0 is the BMS reporting none for a while (e.g. at night): SoH moves
// over months, so the last value is kept rather than cleared (skill section 12).
const batterySoh = (field) => (data) => (Number(data[field]) > 0 ? Number(data[field]) : undefined);
// noah: the warmest of its installed packs (battery1Temp..battery4Temp, unused slots read 0)
const noahBatteryTemp = (data) => {
  const packs = Math.min(4, Number(data.batteryPackageQuantity) || 1);
  const temps = Array.from({ length: packs }, (_, i) => num(data[`battery${i + 1}Temp`]))
    .filter((t) => Number.isFinite(t));
  return temps.length ? Math.max(...temps) : undefined;
};

// One battery per unit: Growatt reports a unit's batteries as one (min: the whole stack on bdc1,
// noah: totalBatteryPack*). bdc2 is not a second battery - bdc2ChargeTotal is bdcBusRef / 10.
const batteryMap = {
  // inv, max: no battery

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
    // doc-derived (OpenAPI 4.2.8), confirmed on one sph with an ARK-XH battery (PR #23)
    measure_soh: ['getLastData', batterySoh('bmsSOH')],
    measure_temperature: ['getLastData', (data) => num(data.batteryTemperature)],
  },

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
    // doc-derived (OpenAPI 4.2.14), not verified
    measure_soh: ['getLastData', batterySoh('bmsSOH')],
    measure_temperature: ['getLastData', (data) => num(data.batteryTemperature)],
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
    // confirmed live (FQP0E3D0JR: 97)
    measure_soh: ['getLastData', batterySoh('bmsSoh')],
    // target_power: ['getChargePowerTarget', getBatTargetPower, setBatTargetPower],
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
    // doc-derived (OpenAPI 4.2.20), not verified
    measure_soh: ['getLastData', batterySoh('soh')],
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
    // doc-derived (OpenAPI 4.2.23), not verified
    measure_soh: ['getLastData', batterySoh('bmsSOH')],
  },

  noah: {
    // already signed, positive charging (verified over a day of history); do not apply the status bits
    measure_power: ['getLastData', (data) => Number(data.totalBatteryPackChargingPower)],
    measure_battery: ['getLastData', (data) => Number(data.totalBatteryPackSoc)],
    // 'meter_power.charged': [(data) => Number(data.echarge1Total)],
    // 'meter_power.discharged': [(data) => Number(data.edischarge1Total)],
    battery_charging_state: ['getLastData', (data) => {
      const status = Number(data.totalBatteryPackChargingStatus);
      if (status & 1) return 'charging';
      if (status & 2) return 'discharging';
      return 'idle';
    }],
    // confirmed live
    measure_soh: ['getLastData', batterySoh('batterySoh')],
    measure_temperature: ['getLastData', noahBatteryTemp],
  },
};

// Set by the device from the time since the last upload (common_device.js), not from a field; the
// last capability of every device.
const CONNECTIVITY = ['getLastData', null];
[inverterMap, meterMap, batteryMap].forEach((map) => Object.values(map).forEach((caps) => {
  caps.alarm_connectivity = CONNECTIVITY;
}));

// The inverter2 capability map for one device. A hybrid without battery history (hasBattery
// false) gets the string inverter layout: its ac_inverter capabilities would duplicate the others.
const inverterCapabilities = (deviceType, hasBattery) => {
  const base = inverterMap[deviceType];
  if (!base || hasBattery !== false) return base;
  const resolved = {};
  for (const [cap, entry] of Object.entries(base)) {
    if (cap === 'measure_power.ac_inverter') continue; // identical to measure_power without a battery
    if (cap === 'meter_power.ac_inverter') {
      resolved['meter_power.dc_solar'] = ['getLastData', dcYieldTotal]; // Total PV input kWh (DC)
      continue;
    }
    resolved[cap] = entry;
  }
  return resolved;
};

// Readable model name: the user's alias unless it is the serial, else modelText, else a
// non-numeric model (noah)
const deviceModel = (info, deviceSn) => {
  const alias = String(info.alias ?? info.treeName ?? '').trim();
  if (alias && alias !== deviceSn) return alias;
  const modelText = String(info.modelText ?? '').trim();
  if (modelText) return modelText;
  const { model } = info;
  if (typeof model === 'string' && model.trim() && Number.isNaN(Number(model))) return model.trim();
  return undefined;
};

// meter2 has no power settings
const usesPowerSettings = (driverId) => driverId !== 'meter2';

// noah target_power is in W and its deviceInfo has no rated power: setPower (doc 4.3.2) allows
// NOAH 0-800 W and NEXA 0-1000 W, told apart by model only. Unknown models get the higher limit,
// since a ceiling set too low could never be reached.
const NOAH_MAX_W = 800;
const NEXA_MAX_W = 1000;

// target_power min/max/step from the rated power; shared by pairing, migrate and onSettings
const targetPowerOptions = (driverId, settings) => {
  const set = settings || {};
  if (driverId === 'battery2') {
    return {
      min: -(Number(set.maxChargePower || set.nominalPower || 3000)),
      max: Number(set.maxDischargePower || set.nominalPower || 3000),
    };
  }
  if (set.deviceType === 'noah') {
    return { min: 0, max: /noah/i.test(String(set.model || '')) ? NOAH_MAX_W : NEXA_MAX_W, step: 1 };
  }
  // sent as a percentage (doc 4.3.2), so step by 1% of rated power or the slider drifts after a poll
  const max = Number(set.nominalPower || 3000);
  return { min: 0, max, step: Math.max(1, Math.round(max / 100)) };
};

// The serial number field differs per device type
const SN_FIELDS = ['deviceSn', 'serialNum', 'inverterId', 'mixSn', 'spaSn', 'hpsSn', 'tlxSn', 'maxSn', 'pcsSn'];
const deviceSnOf = (entry) => (entry
  ? SN_FIELDS.map((f) => entry[f]).find((v) => typeof v === 'string' && v !== '')
  : undefined);

// The deviceType queryDeviceList gives for a serial
const listedDeviceType = (list, deviceSn) => (Array.isArray(list)
  ? list.find((dev) => deviceSnOf(dev) === deviceSn)?.deviceType
  : undefined);

// Upload time on the payload's clock (inv: timeCalendar, min: calendar, noah: numeric `time`);
// measured up to 6 h behind real time on all three.
const uploadTimeOf = (entry) => {
  if (!entry) return 0;
  const raw = entry.calendar ?? entry.timeCalendar ?? (typeof entry.time === 'number' ? entry.time : undefined);
  const at = Number(raw);
  return Number.isFinite(at) && at > 0 ? at : 0;
};

// Lifetime energy counters, which only grow. meter2's meter_power is net (import - export).
const isLifetimeCounter = (driverId, cap) => cap.startsWith('meter_power') && !cap.endsWith('.today')
  && !(driverId === 'meter2' && cap === 'meter_power');

module.exports = {
  inverter2Map: inverterMap,
  meter2Map: meterMap,
  battery2Map: batteryMap,
  hasBatteryHistory,
  inverterCapabilities,
  isLifetimeCounter,
  solarYield,
  solarYieldTotal,
  deviceSnOf,
  uploadTimeOf,
  listedDeviceType,
  deviceModel,
  targetPowerOptions,
  usesPowerSettings,
};

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

// Efficiency assumed for the battery term when the live figure is unusable (see calcSolarAC).
// 98% is the top of the band these hybrids actually reach, so the correction errs towards the
// old uncorrected behaviour rather than overshooting it.
const FALLBACK_EFFICIENCY_PCT = 98;

// Helper to calculate Gross Solar AC output (accounting for battery charge/discharge).
//
// On a DC-coupled hybrid the panels and the battery share a DC bus, and only the inverter's
// DC -> AC stage produces `pac`. So the DC actually converted is `ppv - charge + discharge`, and
// the AC equivalent of the *whole* solar yield is `ppv * efficiency`. Rewritten around `pac`:
//
//   solarAC = ppv * n = (dcIn + charge - discharge) * n = pac + (charge - discharge) * n
//
// The battery term is the only part that needs converting - `pac` is already AC. Scaling just
// that term (rather than computing `ppv * n` directly) keeps the estimate anchored to a measured
// AC value, so when `efficiencyPct` falls back to an assumption the assumption only touches the
// battery contribution instead of the entire reading.
//
// Without the factor this added DC watts to AC watts as if they were the same unit, overstating
// the yield by `battery power * (1 - n)` - about 5% of whatever the battery was doing at that
// moment, so nil when it idles and a few percent while it charges hard.
const calcSolarAC = (pac, pcharge, pdischarge, efficiencyPct) => {
  const ac = Number(pac ?? 0);
  const charge = Number(pcharge ?? 0);
  const discharge = Number(pdischarge ?? 0);
  // inverterEfficiency() yields undefined whenever it has nothing meaningful to report (net DC
  // below its floor, or an implausible ratio); anything outside a physically sane band is treated
  // the same way, since a passive converter cannot exceed 100%.
  const usable = Number.isFinite(efficiencyPct) && efficiencyPct >= 50 && efficiencyPct <= 100;
  const eff = (usable ? efficiencyPct : FALLBACK_EFFICIENCY_PCT) / 100;
  return Math.max(0, ac + (charge - discharge) * eff);
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

// ---------------------------------------------------------
// Whole-inverter conversion efficiency: AC out / all DC in.
//
// "All DC in" is the PV strings plus whatever the battery contributes, minus whatever it absorbs:
// on a hybrid the battery sits on the same DC bus as the strings, so a discharging battery is an
// extra DC source and a charging one is a DC sink. Both belong in the denominator, otherwise the
// figure collapses whenever the battery is busy (measured on a real MOD 8KTL3-XH: 87.9% without
// the battery term vs 94.9% with it, on the same sample).
//
// Battery power is named differently per family: storage uses pcharge/pdischarge, sph/spa use
// pcharge1/pdischarge1, min/wit/sph-s use bdc1+bdc2, noah uses a single field plus a status
// bitmask. They are disjoint, so summing whatever is present is safe. Returns net DC power,
// positive when the battery is charging (a sink).
const batteryDcPower = (data) => {
  if (data.totalBatteryPackChargingPower !== undefined) { // noah
    const p = Number(data.totalBatteryPackChargingPower) || 0;
    // eslint-disable-next-line no-bitwise
    return (Number(data.totalBatteryPackChargingStatus) & 2) ? -p : p;
  }
  const charge = Number(data.bdc1ChargePower ?? 0) + Number(data.bdc2ChargePower ?? 0)
    + Number(data.pcharge ?? 0) + Number(data.pcharge1 ?? 0);
  const discharge = Number(data.bdc1DischargePower ?? 0) + Number(data.bdc2DischargePower ?? 0)
    + Number(data.pdischarge ?? 0) + Number(data.pdischarge1 ?? 0);
  return charge - discharge;
};

// Returns undefined - never null - when there is no meaningful conversion to measure, so
// #setCapability skips the update and the capability holds its last known reading instead of
// blanking out (see common_device.js #setCapability for the undefined/null contract). Efficiency
// is a slow-moving property of the hardware, so a value from earlier in the day is far more
// useful to show than an empty tile; the alternative made the capability flicker every time the
// inverter drifted across the floor at dawn and dusk. The cases that yield no reading:
//   - net DC below a floor: the ratio is dominated by 0.1 A/0.1 V quantisation and by the
//     inverter's own auxiliary draw
//   - net DC negative: the battery is charging from the grid, so power flows AC -> DC and there
//     is no DC -> AC efficiency to report
//   - result outside a plausible band: a passive converter cannot exceed 100%, so anything above
//     that is non-atomic register sampling rather than a real reading
const inverterEfficiency = (data, settings) => {
  const pac = num(data.pac);
  const ppv = num(data.ppv);
  if (pac === undefined || ppv === undefined) return undefined; // device does not report these
  const dcIn = ppv - batteryDcPower(data);
  const floor = Math.max(50, Number(settings?.nominalPower || 0) * 0.02);
  if (dcIn < floor) return undefined; // hold the last reading
  const pct = (pac / dcIn) * 100;
  if (!Number.isFinite(pct) || pct < 0 || pct > 110) return undefined; // hold the last reading
  return Math.round(pct * 10) / 10;
};

// ---------------------------------------------------------
// Solar yield energy counters.
//
// A `solarpanel`-class device should report what the panels yielded, on the AC side where the
// hardware reports it. Which field carries that differs by device family, and the difference is
// not cosmetic:
//
//  - String inverters (inv/max/noah) have no battery, so the inverter's own AC generation counter
//    IS the solar yield. 'inv' names it powerToday/powerTotal (v1-era naming, confirmed live on
//    CT04130016), 'min'/'noah' name it eacToday/eacTotal (v4-era naming, matching the Modbus
//    register labels "Eac today"/"Eac total"). Accept either, and fall back to the DC total for a
//    family that reports neither - 'max' has never been seen in a live payload.
//  - Hybrids (min/sph/spa/wit/sph-s/storage) DO have a battery, and there eacTotal is emphatically
//    not solar yield: it drops the PV that went into the battery and adds battery discharge back
//    in. Measured on a real MOD 8KTL3-XH on two separate days, eacToday sat 36% below the actual
//    PV harvest both times. No single field carries "AC solar yield" for these, so they keep the
//    DC total - mirroring how their measure_power uses calcSolarAC() rather than bare pac.
const dcYieldTotal = (data) => num(data.epvTotal);
// 'epvToday' exists only on the 'storage' type; every other family reports per-string epvNToday.
// Returns undefined - never 0 - when the device reports none of them, so the capability stays
// blank instead of asserting a real zero.
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
// Hybrids only: what actually left the inverter as AC, battery discharge included. This is
// inverter throughput, NOT solar yield - see the note above - which is why it gets its own
// suffixed capability rather than being used for meter_power.
const inverterYieldTotal = (data) => num(data.eacTotal);

// Whether this device has ever moved energy through a battery.
//
// A hybrid sold with a battery slot is not necessarily fitted with one - soesterweg10's MIN 5000
// runs bare - and a hybrid that has never charged or discharged is, for yield purposes, a string
// inverter: nothing contaminates its AC generation counter, so eacTotal IS the solar yield and
// using epvTotal instead makes Homey Energy count the conversion losses as harvest (1.15% on that
// device). This reads the LIFETIME counters, not the instantaneous power: an installed battery
// that merely happens to be idle right now still has a non-zero history, so a momentary lull
// cannot be mistaken for an absent battery.
//
// Every naming variant is checked because the families disagree (see batteryDcPower): min/wit/
// sph-s carry bdc1*/bdc2* plus echarge*/edischarge*, storage is documented with a capital C in
// eChargeTotal, and eacChargeTotal (charging from the grid) proves a battery on its own. Returns
// undefined - not false - when a payload carries none of them, so a family we cannot judge keeps
// the safe DC behaviour rather than being silently switched.
const BATTERY_ENERGY_TOTALS = [
  'echargeTotal', 'eChargeTotal', 'edischargeTotal', 'eDischargeTotal', 'eacChargeTotal',
  'bdc1ChargeTotal', 'bdc1DischargeTotal', 'bdc2ChargeTotal', 'bdc2DischargeTotal',
];
const hasBatteryHistory = (data) => {
  const present = BATTERY_ENERGY_TOTALS.map((field) => num(data[field])).filter((v) => v !== undefined);
  if (present.length === 0) return undefined; // no battery counters at all: cannot tell
  return present.some((v) => v > 0);
};

// Solar yield for the hybrid families: the DC total normally, but the AC total on a unit with no
// battery history, where AC is both available and more accurate. capabilityTitles.js#solarYieldTitles
// applies the same rule to the capability titles, so the label always matches the side in use.
const solarYieldTotal = (data) => (hasBatteryHistory(data) === false ? acYieldTotal(data) : dcYieldTotal(data));
const solarYieldToday = (data) => (hasBatteryHistory(data) === false ? acYieldToday(data) : dcYieldToday(data));

// =========================================================
// device capability mapping
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
  },
  storage: {
    measure_power: ['getLastData', (data, settings) => calcSolarAC(
      data.pac, data.pcharge, data.pdischarge, inverterEfficiency(data, settings),
    )], // Gross Solar Yield
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', solarYieldTotal], // Total solar yield kWh (DC, or AC when no battery)
    'meter_power.today': ['getLastData', solarYieldToday], // Today solar yield kWh (DC, or AC when no battery)
    'measure_power.ac_inverter': ['getLastData', (data) => Number(data.pac)],
    target_power: ['getActivePower', getTargetPower, setTargetPower],
    'meter_power.ac_inverter': ['getLastData', inverterYieldTotal], // Inverter AC throughput kWh
    measure_efficiency: ['getLastData', inverterEfficiency],
  },
  max: {
    measure_power: ['getLastData', (data) => Number(data.pac ?? data.ppv)], // AC Output from Solar
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', acYieldTotal], // Total solar yield kWh (AC)
    'meter_power.today': ['getLastData', acYieldToday], // Today solar yield kWh (AC)
    target_power: ['getActivePower', getTargetPower, setTargetPower],
    'meter_power.dc_solar': ['getLastData', dcYieldTotal], // Total PV input kWh (DC)
    measure_efficiency: ['getLastData', inverterEfficiency],
  },
  sph: {
    measure_power: ['getLastData', (data, settings) => calcSolarAC(
      data.pac, data.pcharge1, data.pdischarge1, inverterEfficiency(data, settings),
    )], // Gross Solar Yield
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', solarYieldTotal], // Total solar yield kWh (DC, or AC when no battery)
    'meter_power.today': ['getLastData', solarYieldToday], // Today solar yield kWh (DC, or AC when no battery)
    'measure_power.ac_inverter': ['getLastData', (data) => Number(data.pac)],
    target_power: ['getActivePower', getTargetPower, setTargetPower],
    'meter_power.ac_inverter': ['getLastData', inverterYieldTotal], // Inverter AC throughput kWh
    measure_efficiency: ['getLastData', inverterEfficiency],
  },
  spa: {
    measure_power: ['getLastData', (data, settings) => calcSolarAC(
      data.pac, data.pcharge1, data.pdischarge1, inverterEfficiency(data, settings),
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
      Number(data.bdc1ChargePower ?? 0) + Number(data.bdc2ChargePower ?? 0),
      Number(data.bdc1DischargePower ?? 0) + Number(data.bdc2DischargePower ?? 0),
      inverterEfficiency(data, settings),
    )], // Gross Solar Yield
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', solarYieldTotal], // Total solar yield kWh (DC, or AC when no battery)
    'meter_power.today': ['getLastData', solarYieldToday], // Today solar yield kWh (DC, or AC when no battery)
    'measure_power.ac_inverter': ['getLastData', (data) => Number(data.pac)],
    target_power: ['getActivePower', getTargetPower, setTargetPower],
    'meter_power.ac_inverter': ['getLastData', inverterYieldTotal], // Inverter AC throughput kWh
    measure_efficiency: ['getLastData', inverterEfficiency],
  },
  wit: {
    measure_power: ['getLastData', (data, settings) => calcSolarAC(
      data.pac,
      Number(data.bdc1ChargePower ?? 0) + Number(data.bdc2ChargePower ?? 0),
      Number(data.bdc1DischargePower ?? 0) + Number(data.bdc2DischargePower ?? 0),
      inverterEfficiency(data, settings),
    )], // Gross Solar Yield
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', solarYieldTotal], // Total solar yield kWh (DC, or AC when no battery)
    'meter_power.today': ['getLastData', solarYieldToday], // Today solar yield kWh (DC, or AC when no battery)
    'measure_power.ac_inverter': ['getLastData', (data) => Number(data.pac)],
    target_power: ['getActivePower', getTargetPower, setTargetPower],
    'meter_power.ac_inverter': ['getLastData', inverterYieldTotal], // Inverter AC throughput kWh
    measure_efficiency: ['getLastData', inverterEfficiency],
  },
  'sph-s': {
    measure_power: ['getLastData', (data, settings) => calcSolarAC(
      data.pac,
      Number(data.bdc1ChargePower ?? 0) + Number(data.bdc2ChargePower ?? 0),
      Number(data.bdc1DischargePower ?? 0) + Number(data.bdc2DischargePower ?? 0),
      inverterEfficiency(data, settings),
    )], // Gross Solar Yield
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', solarYieldTotal], // Total solar yield kWh (DC, or AC when no battery)
    'meter_power.today': ['getLastData', solarYieldToday], // Today solar yield kWh (DC, or AC when no battery)
    'measure_power.ac_inverter': ['getLastData', (data) => Number(data.pac)],
    target_power: ['getActivePower', getTargetPower, setTargetPower],
    'meter_power.ac_inverter': ['getLastData', inverterYieldTotal], // Inverter AC throughput kWh
    measure_efficiency: ['getLastData', inverterEfficiency],
  },
  noah: {
    measure_power: ['getLastData', (data) => Number(data.pac ?? data.ppv)], // Output Power W (BUCK)
    'measure_power.dc_solar': ['getLastData', (data) => Number(data.ppv)],
    meter_power: ['getLastData', acYieldTotal], // Total solar yield kWh (AC)
    'meter_power.today': ['getLastData', acYieldToday], // Today solar yield kWh (AC)
    target_power: ['getActivePower', (val) => Number(val?.value ?? val), (val) => ({ call: 'setActivePower', value: String(Math.round(Number(val))) })], // Absolute Watts
    measure_efficiency: ['getLastData', inverterEfficiency],
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
// Resolved capability map for one inverter2 device.
//
// A hybrid that has never used a battery is a string inverter in every way that shows: its solar
// yield is on the AC side, and the two ac_inverter capabilities become meaningless duplicates -
// measure_power.ac_inverter equals measure_power (calcSolarAC's battery term is nil), and
// meter_power.ac_inverter equals meter_power (both eacTotal). So swap them for the string layout:
// drop the duplicate power tile and hand its energy slot to meter_power.dc_solar, which keeps the
// DC lifetime total on screen instead of losing it. Iterating the hybrid map in place means the
// result comes out in exactly the inv/max order, so the GUI is indistinguishable.
//
// Anything other than an explicit false (a battery present, or a payload that cannot say) returns
// the map unchanged. Defined after inverterMap because it reads it.
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

module.exports = {
  inverter2Map: inverterMap,
  meter2Map: meterMap,
  battery2Map: batteryMap,
  hasBatteryHistory,
  inverterCapabilities,
};

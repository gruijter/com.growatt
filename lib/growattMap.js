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
const calcSolarAC = (pac, pcharge, pdischarge, efficiencyPct, ppv) => {
  const ac = Number(pac ?? 0);
  const charge = Number(pcharge ?? 0);
  const discharge = Number(pdischarge ?? 0);
  // inverterEfficiency() yields undefined whenever it has nothing meaningful to report (net DC
  // below its floor, or an implausible ratio); anything outside a physically sane band is treated
  // the same way, since a passive converter cannot exceed 100%.
  const usable = Number.isFinite(efficiencyPct) && efficiencyPct >= 50 && efficiencyPct <= 100;
  const eff = (usable ? efficiencyPct : FALLBACK_EFFICIENCY_PCT) / 100;
  const solarAC = Math.max(0, ac + (charge - discharge) * eff);
  // The `pac + battery` identity above only holds while the battery charges FROM the panels.
  // Charging it from the grid puts watts into `charge` that never came through the array
  // (eacChargeTotal - "energy charged from the grid" - is 679.7 kWh on FQP0E3D0JR, so this is
  // routine, not hypothetical). At night that turned a 2 kW grid charge into ~1960 W of reported
  // solar on a class:'solarpanel' device, which Homey Energy books as production.
  //
  // `ppv * n` is the same quantity by the derivation above, so it is the physical ceiling: no
  // amount of battery activity can yield more AC solar than the array is feeding in right now.
  // Cap on it rather than trusting the battery term alone - at night ppv is 0 and the cap is 0.
  //
  // While the battery charges from the panels the cap is INERT, not merely close: substituting
  // n = pac / (ppv - charge) makes both expressions pac * ppv / (ppv - charge) exactly. Verified
  // by sweeping 592 daylight states (ppv 500-8000 W, charge up to 60% of it) - the cap altered
  // none of them, max deviation 9e-13 W. That identity is why inverterEfficiency() must return
  // full precision; rounding it to 1 decimal broke it and cost 2.3 W on the FQP0E3D0JR sample.
  //
  // So the cap engages in exactly two cases, both correct: `n` is the 98% fallback (the battery
  // term is not backed by a live measurement), or ppv genuinely cannot support the battery term
  // (grid charging - 1960 W uncapped vs 0 W capped on the night sample above).
  //
  // Skipped when the device does not report `ppv` at all: capping on a missing field would zero
  // the reading, and no payload has ever been captured for max/sph/spa/wit/sph-s/storage (see
  // zzz_docs/API-FIELD-NOTES.md, account inventory) to confirm they carry it.
  const dc = (ppv === undefined || ppv === null) ? NaN : Number(ppv);
  if (!Number.isFinite(dc)) return solarAC;
  return Math.min(solarAC, Math.max(0, dc * eff));
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
// The 'storage' type is a third naming again: the OpenAPI field table (section 4.3.13, "Access to
// the latest energy storage machine real-time data") lists a single bare `vac` - "Grid voltage (V)"
// - with no per-phase variant at all, which left ALL THREE voltage capabilities blank on every
// 'storage' device, the same way vac1 did on 'inv' before vacr was added. Only phase 1 can take it;
// phases 2 and 3 stay unreported there, which is right for a single-phase unit. Doc-derived only -
// no 'storage' device has ever been reachable to confirm it live.
const acVoltage = (phase) => (data) => Number(data[`vac${phase}`]
  ?? data[['vacr', 'vacs', 'vact'][phase - 1]]
  ?? (phase === 1 ? data.vac : undefined));
// AC current per phase. Same per-family naming split as acVoltage() above - 'inv' uses
// iacr/iacs/iact where the v4 families use iac1/iac2/iac3 - so it gets the same fallback rather
// than a second bare-name lookup that would leave every 'inv' current blank (the exact bug
// acVoltage() was written to fix). Confirmed live: iac1/2/3 = 1.0 A on min FQP0E3D0JR, and
// iacr/iacs/iact present on inv CT04130016.
const acCurrent = (phase) => (data) => Number(data[`iac${phase}`] ?? data[['iacr', 'iacs', 'iact'][phase - 1]]);

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
// pcharge1/pdischarge1, min/wit/sph-s use bdc1+bdc2, noah reports a single already-signed field.
// They are disjoint, so summing whatever is present is safe. Returns net DC power, positive when
// the battery is charging (a sink).
//
// noah's totalBatteryPackChargingPower already follows exactly that convention, so it is used as
// is. Re-applying the totalBatteryPackChargingStatus bitmask to it double-negates - see the note
// in batteryMap.noah for the day of history that settles the sign.
const batteryDcPower = (data) => {
  if (data.totalBatteryPackChargingPower !== undefined) { // noah
    return Number(data.totalBatteryPackChargingPower) || 0;
  }
  // bdc2* is deliberately excluded. On a single-battery unit the whole bdc2 group is junk rather
  // than absence - FQP0E3D0JR has one battery yet reports bdc2ChargePower 3.485, bdc2Status 24,
  // bdc2FaultType 31 - and bdc2ChargeTotal is not even an energy counter (it aliases bdcBusRef/10).
  // No unit with a genuine second battery has ever been observed, so per zzz_docs/API-FIELD-NOTES.md
  // section 9.3 nothing in the group is trusted here. A real two-battery unit would undercount its
  // second pack in `dcIn`; that is the safer error, and needs a real payload before it can be fixed.
  const charge = Number(data.bdc1ChargePower ?? 0)
    + Number(data.pcharge ?? 0) + Number(data.pcharge1 ?? 0);
  const discharge = Number(data.bdc1DischargePower ?? 0)
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
//   - no AC output at all while DC still clears the floor: the converter is idle or curtailed, not
//     converting at 0% efficiency. Seen on a noah, which routinely outputs nothing for hours while
//     the panels charge the battery - 3 of 477 records on 2026-09-01 had pac 0 against ppv 53 W,
//     each of which would otherwise have stamped a real 0.0% onto the tile and left it there. A
//     hybrid overnight (pac 0, battery charging from the grid) reaches the same state, so the guard
//     is not noah-specific.
const inverterEfficiency = (data, settings) => {
  const pac = num(data.pac);
  const ppv = num(data.ppv);
  if (pac === undefined || ppv === undefined) return undefined; // device does not report these
  if (!(pac > 0)) return undefined; // idle or curtailed - hold the last reading
  const dcIn = ppv - batteryDcPower(data);
  const floor = Math.max(50, Number(settings?.nominalPower || 0) * 0.02);
  if (dcIn < floor) return undefined; // hold the last reading
  const pct = (pac / dcIn) * 100;
  // A passive DC->AC converter cannot exceed 100%, so anything above it is a measurement artefact,
  // never a reading. The ceiling used to be 110, which let real nonsense onto the tile: FQP0E3D0JR
  // reported pac 523.2 against ppv 476.5 with the battery idle at its 10% cut-off (every bdc*/bms
  // power field zero, so there was nothing to subtract) and published 109.8%. That same payload
  // also had ppv 476.5 against ppv1+ppv2 = 442.0, while each string's own v*i reconciled exactly -
  // i.e. ppv itself was skewed, at 6.5% of nominal load where sampling skew dominates.
  // 100 also matches calcSolarAC()'s `usable` band, which already rejected these samples; the two
  // now agree instead of one calling a value implausible while the other displays it.
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return undefined; // hold the last reading
  // Returned at full precision deliberately. The capability declares "decimals": 1, which is a
  // display hint - homey-lib carries no rounding logic for it (checked lib/Capability/index.js),
  // and @types/homey words the equivalent Insights option as "number of decimals visible" - so
  // the GUI shows 94.9 either way and nothing is gained by rounding at the source.
  //
  // It matters because calcSolarAC() consumes this value as arithmetic, not as a reading, and
  // there `pac + charge * n` and the `ppv * n` ceiling are the SAME expression: substituting
  // n = pac / (ppv - charge) gives pac * ppv / (ppv - charge) for both. Rounding to 1 decimal
  // broke that identity and made the cap bite on the rounding error alone (2.3 W on the
  // FQP0E3D0JR daylight sample). At full precision the cap is inert whenever the live efficiency
  // is usable, and only engages where it should: when `n` is the 98% fallback, i.e. exactly when
  // the battery term is not backed by a real measurement.
  return pct;
};

// ---------------------------------------------------------
// Solar yield energy counters.
//
// A `solarpanel`-class device should report what the panels yielded, on the AC side where the
// hardware reports it. Which field carries that differs by device family, and the difference is
// not cosmetic:
//
//  - String inverters (inv/max) have no battery, so the inverter's own AC generation counter IS
//    the solar yield. 'inv' names it powerToday/powerTotal (v1-era naming, confirmed live on
//    CT04130016), 'min' names it eacToday/eacTotal (v4-era naming, matching the Modbus register
//    labels "Eac today"/"Eac total"). Accept either, and fall back to the DC total for a family
//    that reports neither - 'max' has never been seen in a live payload.
//  - 'noah' looks like it belongs in that first group and does not. A NOAH has a battery AND no AC
//    side at all: its only output is a DC port feeding a separate micro-inverter (user manual:
//    "DC Output, 40-50V, 18A, 800W MAX"). Its eac* counters keep the inverter naming but count PV
//    energy on the DC input, so they are the equivalent of another family's epv* - see
//    noahPvYieldTotal below.
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
// noah only: the same eacToday/eacTotal fields, but on this family they are a DC PV counter, not an
// AC one - hence a separate name so the map cannot claim a side the hardware does not have. Proven
// against a full day of queryHistoricalData for 0PVP40ZR162T006Y (2026-09-01, 477 records): between
// 00:02 and 06:31 the unit pushed 1.90 kWh out of the battery with ppv flat at 0, and eacTotal did
// not move off 3206.0; between 09:00 and 12:10 it pushed nothing out at all (pac 0 throughout) while
// the panels made 1.87 kWh, and eacToday rose 0.1 -> 1.9. Over the whole day the integral of ppv was
// 5.46 kWh against a 5.4 kWh rise in eacTotal, where the integral of pac was 4.62 kWh. So the
// counter follows the panels, ignores battery discharge, and includes PV that went into the battery.
const noahPvYieldTotal = (data) => num(data.eacTotal);
const noahPvYieldToday = (data) => num(data.eacToday);
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
// eChargeTotal, and eacChargeTotal (charging from the grid) proves a battery on its own. bmsSoc
// counts too: a BMS reporting a state of charge means a pack is wired up, even before it has
// accumulated any energy. Returns undefined - not false - when a payload carries none of them, so
// a family we cannot judge keeps the safe DC behaviour rather than being silently switched.
//
// bdc2ChargeTotal/bdc2DischargeTotal are NOT trusted on their own, because bdc2ChargeTotal is not
// a battery counter at all on a unit with one battery - it carries bdcBusRef / 10, the DC bus
// reference voltage. Verified on two devices in the same response:
//   FNPAF6J05U  bdcBusRef 6208 -> bdc2ChargeTotal 620.8
//   FQP0E3D0JR  bdcBusRef 7294 -> bdc2ChargeTotal 729.4
// and it DROPPED from 622.1 to 620.8 across two reads three minutes apart, which no lifetime
// counter does. Left unguarded it declares a battery on every battery-less MIN. So a bdc2 counter
// only counts when a field that cannot be aliased agrees. (This is also the source of the bogus
// second battery device common_driver.js creates - still unfixed there.)
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
    // OpenAPI 4.3.8/4.3.9: `temperature` "Temperature (C)". Live 14.7 on CT04130016.
    measure_temperature: ['getLastData', (data) => num(data.temperature)],
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
    // OpenAPI 4.3.13/4.3.14 list `temperature` for the energy-storage family too. Doc-derived;
    // no 'storage' device has ever been reachable.
    measure_temperature: ['getLastData', (data) => num(data.temperature)],
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
      // bdc2* deliberately excluded - it is junk on a single-battery unit, not absence
      // (bdc2ChargePower reads 3.485 W on FQP0E3D0JR while bdc1 does the real work), so it
      // added a few watts of standing phantom solar every night. See batteryDcPower().
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
    // temp1 of temp1..temp5. 'min' has no `temperature` key and the v4 field table is in
    // neither vendor PDF, so which sensor is the inverter body is NOT documented - temp1 is
    // chosen as the first channel, matching the ppv1/vac1/iac1 numbering convention. Observed
    // 33.3 and 32.0 on FQP0E3D0JR while temp2 ran ~14 C hotter (47.5/46.8, heatsink-like).
    // A user-facing correction is cheap if this turns out to be the wrong sensor.
    measure_temperature: ['getLastData', (data) => num(data.temp1)],
  },
  wit: {
    measure_power: ['getLastData', (data, settings) => calcSolarAC(
      data.pac,
      // bdc2* deliberately excluded - it is junk on a single-battery unit, not absence
      // (bdc2ChargePower reads 3.485 W on FQP0E3D0JR while bdc1 does the real work), so it
      // added a few watts of standing phantom solar every night. See batteryDcPower().
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
  },
  'sph-s': {
    measure_power: ['getLastData', (data, settings) => calcSolarAC(
      data.pac,
      // bdc2* deliberately excluded - it is junk on a single-battery unit, not absence
      // (bdc2ChargePower reads 3.485 W on FQP0E3D0JR while bdc1 does the real work), so it
      // added a few watts of standing phantom solar every night. See batteryDcPower().
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
  },
  // A NOAH is not an inverter: panels and battery feed a DC-DC converter whose only output is a DC
  // port to a separate micro-inverter. So the two power tiles are the other way round from every
  // other type here - measure_power is the panels (the solarpanel-class device's own quantity) and
  // the converter's output, which carries battery discharge too, gets its own suffixed capability
  // rather than occupying measure_power. capabilityTitles.js stamps the matching titles per device.
  noah: {
    measure_power: ['getLastData', (data) => Number(data.ppv)], // Solar power (DC), panels only
    'measure_power.dc_converter': ['getLastData', (data) => Number(data.pac ?? data.ppv)], // Converter output to the micro-inverter, battery discharge included
    meter_power: ['getLastData', noahPvYieldTotal], // Total solar yield kWh (DC)
    'meter_power.today': ['getLastData', noahPvYieldToday], // Today solar yield kWh (DC)
    target_power: ['getActivePower', (val) => Number(val?.value ?? val), (val) => ({ call: 'setActivePower', value: String(Math.round(Number(val))) })], // Absolute Watts
    measure_efficiency: ['getLastData', inverterEfficiency],
    // noah names it systemTemp - no `temperature` key at all. Live 7.3 on 0PVP40ZR162T006Y.
    measure_temperature: ['getLastData', (data) => num(data.systemTemp)],
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
    // 'inv' names its output currents iacr/iacs/iact - OpenAPI section 4.3.8/4.3.9 field tables,
    // "Output current 1 channel / 2 way / 3-way (A)", alongside the vacr/vacs/vact voltages.
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
    // iac1/iac2/iac3, confirmed live on FQP0E3D0JR (1.0 A on each phase, 2026-09-03).
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
    // totalBatteryPackChargingPower already carries the sign this app's battery convention wants:
    // positive charging, negative discharging - the same as min's bdc1ChargePower - bdc1DischargePower.
    // Do NOT re-apply the totalBatteryPackChargingStatus bitmask to it; that double-negates, so a
    // discharging pack reported +284 W while battery_charging_state next to it said 'discharging'.
    // Verified over a full day of queryHistoricalData for 0PVP40ZR162T006Y (2026-09-01, 477 records):
    // status 2 came with a negative power 220 times and never a positive one, status 1 with a positive
    // power 116 times and never a negative one, and the remainder were idle or sub-30 W transitions.
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

// The human-readable model name, from whichever field the device type happens to carry it in.
// Shared because pairing now settles it too: writing it later counted as a settings change and
// restarted every freshly paired device once - see common_device#onSettings.
const deviceModel = (info, deviceSn) => {
  const alias = String(info.alias ?? info.treeName ?? '').trim();
  if (alias && alias !== deviceSn) return alias;
  const modelText = String(info.modelText ?? '').trim();
  if (modelText) return modelText;
  const { model } = info;
  if (typeof model === 'string' && model.trim() && Number.isNaN(Number(model))) return model.trim();
  return undefined;
};

// Which power settings a driver has any use for. Only inverter2 carries target_power, so only it
// needs a rated power; battery2 declares charge/discharge limits of its own; meter2 uses none of
// them and its settings schema declares none - writing them there stored values no screen could
// show and no code could read.
const usesPowerSettings = (driverId) => driverId !== 'meter2';

// The noah family sets target_power in absolute WATTS rather than a percentage, and its
// deviceInfo carries no rated power at all - pmax, chargePower and dischargePower all come back
// null - so the limit can only come from the documentation. setPower (doc 4.3.2) gives NOAH a
// range of 0-800 W and NEXA 0-1000 W, and both are deviceType `noah`: doc 4.1.1 lists "NOAH 2000"
// and "NEXA 2000" underneath it, so the model name is the only thing separating them.
//
// An unrecognised model takes the HIGHER of the two. target_power is a limiter, not a setpoint:
// ask for more than the hardware allows and the device caps it, which costs nothing, but a ceiling
// set too low means the inverter can never reach full output - permanently, and with nothing in
// the UI to suggest why. The two mistakes are not symmetrical, so the fallback errs upward.
const NOAH_MAX_W = 800;
const NEXA_MAX_W = 1000;

// The min/max target_power accepts, from the device's own rated power. Shared because pairing and
// common_device#migrate must agree exactly: migrate treats any difference as a migration and
// restarts the device, so a formula that drifted between the two would restart every device on
// every boot, forever.
const targetPowerOptions = (driverId, settings) => {
  const set = settings || {};
  if (driverId === 'battery2') {
    return {
      min: -(Number(set.maxChargePower || set.nominalPower || 3000)),
      max: Number(set.maxDischargePower || set.nominalPower || 3000),
    };
  }
  if (set.deviceType === 'noah') {
    // watts end to end, so every position on the slider is one the device can actually take
    return { min: 0, max: /noah/i.test(String(set.model || '')) ? NOAH_MAX_W : NEXA_MAX_W, step: 1 };
  }
  // Everything else goes over the wire as a PERCENTAGE (doc 4.3.2), so the finest distinction the
  // API can carry is one percent of rated power - 33 W on a 3.3 kW inverter. The capability is in
  // watts with a stock step of 1, which promised a precision the round trip cannot keep: asking for
  // 1234 W stored 37% and read back 1221 W, so the slider moved on its own after every poll.
  // Stepping by 1% makes every position expressible, and the value stays where it was put.
  const max = Number(set.nominalPower || 3000);
  return { min: 0, max, step: Math.max(1, Math.round(max / 100)) };
};

// Which field carries the serial number depends on the device type: `min` and most others use
// serialNum, `inv` uses inverterId, and the older families each brought their own. app.js stamps
// the answer onto deviceSn after a poll, pairing matches on it, and the offline tests need the
// same answer - so all three ask here rather than each keeping a copy of the list.
const SN_FIELDS = ['deviceSn', 'serialNum', 'inverterId', 'mixSn', 'spaSn', 'hpsSn', 'tlxSn', 'maxSn', 'pcsSn'];
const deviceSnOf = (entry) => (entry
  ? SN_FIELDS.map((f) => entry[f]).find((v) => typeof v === 'string' && v !== '')
  : undefined);

module.exports = {
  inverter2Map: inverterMap,
  meter2Map: meterMap,
  battery2Map: batteryMap,
  hasBatteryHistory,
  inverterCapabilities,
  deviceSnOf,
  deviceModel,
  targetPowerOptions,
  usesPowerSettings,
};

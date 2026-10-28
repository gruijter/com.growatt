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

/*
 * Register maps for Growatt inverters over Modbus TCP through a ShineWiLan-X2 dongle (Growatt's
 * whitepaper "Single Device Control via Growatt Modbus TCP", 2024-11: port 502, unit id = the
 * inverter's address, function codes 03 and 04, > 50 ms between requests).
 * - Growatt Inverter Modbus RTU Protocol V1.24 (holding 0-124, input 0-124, 1000-1124, 3000-3249)
 * - Growatt VPP Communication Protocol V2.03 (holding 30000: device type code, Table 3-1)
 * Not verified on hardware: every address and scale below is from these documents unless marked.
 *
 * Three register families (V1.20 "Register range for various types of inverter"):
 *  - tlx:     MIC/MIN TL-X, MIN TL-XH, MOD/MID TL3-XH: input 3000-3249
 *  - storage: SPH (input 0-124 inverter, 1000-1124 battery and grid); SPA has no PV, so only
 *             its battery and grid are read (family 'spa')
 *  - tl3:     MID/MAX/MOD/MAC TL3-X: input 0-124
 * Input registers sit at INPUT + address in the register map (lib/registers.js).
 */

const {
  u16, i16, u32, str, scale, round, INPUT,
} = require('./registers');
const { solarTitle } = require('./solarTitles');
const { monotonic, rebase } = require('./deviceHelpers');
const { calcSolarAC, inverterEfficiency } = require('./growattMap');

const I = INPUT;

/** Device type code (VPP V2.03 Table 3-1) -> register family and model name. */
const MODELS = {
  3501: ['storage', 'SPH 3000-6000TL BL'],
  3502: ['storage', 'SPH 3000-6000TL BL-UP'],
  3503: ['storage', 'SPH 3000-6000TL HU'],
  3504: ['storage', 'SPH 3000-6000TL HUB'],
  3601: ['storage', 'SPH 4-10KTL3 BH-UP'],
  3701: ['spa', 'SPA 1000-3000TL BL'],
  3715: ['spa', 'SPA 3000-6000TL AU'],
  3716: ['spa', 'SPA 3000-6000TL AUB'],
  3725: ['spa', 'SPA 4-10KTL3 BH-UP'],
  3735: ['spa', 'SPA 3000TL BL-UP'],
  5100: ['tlx', 'MIN TL-XH'],
  5200: ['tlx', 'MIC/MIN TL-X'],
  5201: ['tlx', 'MIN 7-10KTL-X'],
  // assumed to use the TL-XH map, as the MIN TL-XH (not verified)
  5400: ['tlx', 'MOD/MID TL3-XH'],
  5000: ['tl3', 'MAX 50-100KTL3'],
  5001: ['tl3', 'MID TL3-X'],
  5002: ['tl3', 'MOD TL3-X'],
  5003: ['tl3', 'MAC TL3-X'],
  5500: ['tl3', 'MAX TL3-X HV'],
  5501: ['tl3', 'MAX TL3-X'],
  5502: ['tl3', 'MAX 320-350KTL3-X'],
  // own register maps, not supported here
  5600: ['other', 'WIT/WIS'],
  5601: ['other', 'WIT 29.9-50K-XHU'],
  5800: ['other', 'WIS 210K'],
  5801: ['other', 'WIS 215K-AM'],
};

/**
 * The device type code: VPP holding 30000 on firmware with the VPP protocol, else holding 43
 * (Protocol_II "DTC"; whether it carries the same codes is not verified).
 */
const dtcOf = (regs) => [u16(regs, 30000), u16(regs, 43)].find((code) => MODELS[code]) ?? (u16(regs, 30000) || u16(regs, 43));

/**
 * The register family: from the device type code, else from the input range that answered.
 * undefined while neither is known.
 */
const familyOf = (regs) => {
  const known = MODELS[dtcOf(regs)];
  if (known) return known[0];
  if (regs.has(I + 3000)) return 'tlx';
  if (regs.has(I + 1000)) return 'storage';
  if (regs.has(I + 0)) return 'tl3';
  return undefined;
};

const family = (device) => device.detected.family;

/** WIT/WIS: their own register maps, which these addresses do not describe. */
const unsupportedModel = (regs) => MODELS[dtcOf(regs)]?.[0] === 'other';

// --- identity -----------------------------------------------------------------------------

const IDENTITY = [
  { start: 0, count: 125 }, // firmware, serial number, device type code, trackers and phases, rated power
  { start: 30000, count: 1, optional: true }, // VPP device type code
];

const identity = (regs) => {
  const dtc = dtcOf(regs);
  const serialNumber = str(regs, 23, 5);
  return {
    model: MODELS[dtc] ? MODELS[dtc][1] : (dtc && `DTC ${dtc}`) || undefined,
    serialNumber,
    unitSerial: serialNumber,
    manufacturer: 'Growatt',
    firmware: [str(regs, 9, 3), str(regs, 12, 3)].filter(Boolean).join(' / ') || undefined,
  };
};

/** Holding 44: tracker count in the high byte, phase count in the low byte (0x0203: 2 MPPT, 3 phases). */
const trackers = (regs) => {
  const tp = u16(regs, 44);
  if (tp === undefined) return {};
  const strings = tp >> 8;
  const phases = tp & 0xff;
  return {
    ...(strings >= 1 && strings <= 16 ? { strings } : {}),
    ...([1, 3].includes(phases) ? { phases } : {}),
  };
};

/** Holding 6-7, Pmax in 0.1 VA. */
const ratedPowerOf = (regs) => {
  const rated = round(scale(u32(regs, 6), 10), 0);
  return rated > 0 ? rated : undefined;
};

// --- shared readings ----------------------------------------------------------------------

/** A u32 power or energy register in 0.1 units. */
const tenths = (regs, address, decimals = 1) => round(scale(u32(regs, address), 10), decimals);

/** 1 W / 0.1 kWh registers per family: [tlx, storage and tl3] input addresses. */
const at = (device, tlx, other) => (family(device) === 'tlx' ? I + tlx : I + other);

/** Battery power in W per direction; undefined where the family has no battery registers. */
const batteryPower = (regs, device) => {
  if (family(device) === 'tlx') return { charge: tenths(regs, I + 3180, 0), discharge: tenths(regs, I + 3178, 0) };
  if (['storage', 'spa'].includes(family(device))) return { charge: tenths(regs, I + 1011, 0), discharge: tenths(regs, I + 1009, 0) };
  return { charge: undefined, discharge: undefined };
};

/** Inverter readings in the field names growattMap's helpers use. */
const inverterData = (regs, device) => {
  const { charge, discharge } = device.detected.hasBattery ? batteryPower(regs, device) : {};
  return {
    ppv: tenths(regs, at(device, 3001, 1), 0),
    pac: tenths(regs, at(device, 3023, 35), 0),
    pcharge1: charge,
    pdischarge1: discharge,
  };
};

const settingsOf = (device) => ({ nominalPower: device.detected.ratedPower });

/**
 * DC -> AC efficiency in percent, null while no AC is produced (at night). Undefined while
 * producing keeps the last value: too little DC to tell, or sampling skew (battery power is
 * read a block later than PV and AC).
 */
const efficiency = (regs, device) => {
  const data = inverterData(regs, device);
  if (data.pac === undefined || data.ppv === undefined) return undefined;
  if (!(data.pac > 0)) return null;
  return round(inverterEfficiency(data, settingsOf(device)), 1);
};

/** Solar power on the AC side: AC output without a battery, else growattMap's calcSolarAC. */
const solarPower = (regs, device) => {
  const data = inverterData(regs, device);
  if (data.pac === undefined) return undefined;
  if (!device.detected.hasBattery) return data.pac;
  if (data.pcharge1 === undefined || data.pdischarge1 === undefined) return undefined;
  const pct = inverterEfficiency(data, settingsOf(device));
  return round(calcSolarAC(data.pac, data.pcharge1, data.pdischarge1, pct, data.ppv), 0);
};

/*
 * Side of the solar energy counters, as the cloud inverter (growattMap solarYield): without a
 * battery the AC counter is the solar yield; with one it also counts discharge, so the DC counter.
 * Decided once (detect() keeps `solarSide`); undefined before the first detection.
 */
const solarSide = (detected) => {
  if (detected.solarSide) return detected.solarSide;
  if (detected.hasBattery === false) return 'ac';
  if (detected.hasBattery === true) return 'dc';
  return undefined;
};

/** Today's PV energy: tlx has a total, the others count per string (Epv1-4 today, 0.1 kWh). */
const pvToday = (regs, device) => {
  if (family(device) === 'tlx') return tenths(regs, I + 3083, 2);
  const strings = Math.min(device.detected.strings || 4, 4);
  const values = Array.from({ length: strings }, (_, n) => u32(regs, I + 59 + 4 * n));
  if (values.some((value) => value === undefined)) return undefined;
  return round(scale(values.reduce((sum, value) => sum + value, 0), 10), 2);
};

const solarEnergyToday = (regs, device) => {
  const side = solarSide(device.detected);
  if (!side) return undefined;
  return side === 'ac' ? tenths(regs, at(device, 3049, 53), 2) : pvToday(regs, device);
};

/** Lifetime solar energy for Homey Energy; continues where it was when the side changes. */
const solarEnergyTotal = async (regs, device) => {
  const side = solarSide(device.detected);
  if (!side) return undefined;
  const value = side === 'ac' ? tenths(regs, at(device, 3051, 55), 2) : tenths(regs, at(device, 3053, 91), 2);
  if (value === undefined) return undefined;
  const counted = device.getStoreValue('meter_powerSide');
  if (counted !== side) {
    if (counted) await rebase(device, 'meter_power', value);
    await device.setStoreValue('meter_powerSide', side);
  }
  return monotonic(device, 'meter_power', value);
};

/** A lifetime counter (0.1 kWh) that never falls, for Homey Energy. */
const counter = (name, tlx, other) => async (regs, device) => {
  const value = tenths(regs, at(device, tlx, other), 2);
  if (value === undefined) return undefined;
  return monotonic(device, name, value);
};

/** Status 3 is fault: low byte of input 3000 (tlx), input 0 (tl3, storage). */
const inFault = (regs, device) => {
  const status = u16(regs, at(device, 3000, 0));
  if (status === undefined) return undefined;
  return (family(device) === 'tlx' ? status & 0xff : status) === 3;
};

/** Grid phase `n` (1-3): voltage and current in 0.1 V / 0.1 A. */
const phaseVoltage = (n) => (regs, device) => round(scale(u16(regs, at(device, 3026, 38) + 4 * (n - 1)), 10), 1);
const phaseCurrent = (n) => (regs, device) => round(scale(u16(regs, at(device, 3027, 39) + 4 * (n - 1)), 10), 1);

/** PV string `n` (1-4): voltage, current (0.1) and power (u32, 0.1 W), four registers apart. */
const pvVoltage = (n) => (regs, device) => round(scale(u16(regs, at(device, 3003, 3) + 4 * (n - 1)), 10), 1);
const pvCurrent = (n) => (regs, device) => round(scale(u16(regs, at(device, 3004, 4) + 4 * (n - 1)), 10), 1);
const pvPower = (n) => (regs, device) => tenths(regs, at(device, 3005, 5) + 4 * (n - 1), 0);

const PV_STRINGS = 4;
const pvStringCapabilities = (n) => [`measure_power.pv${n}`, `measure_voltage.pv${n}`, `measure_current.pv${n}`];
const pvStrings = () => Object.fromEntries(Array.from({ length: PV_STRINGS }, (_, i) => i + 1).flatMap((n) => [
  [`measure_power.pv${n}`, pvPower(n)],
  [`measure_voltage.pv${n}`, pvVoltage(n)],
  [`measure_current.pv${n}`, pvCurrent(n)],
]));

// --- detection ----------------------------------------------------------------------------

/** Any value above 0; undefined when none was read. */
const anyAboveZero = (values) => {
  if (values.every((value) => value === undefined)) return undefined;
  return values.some((value) => value > 0);
};

/** A battery is connected or ever was (lifetime counters), so an idle or offline one still counts. */
const hasBattery = (regs, fam) => {
  // BDC connect state, total discharge and charge
  if (fam === 'tlx') return anyAboveZero([u16(regs, I + 3118), u32(regs, I + 3127), u32(regs, I + 3131)]);
  // SoC, total discharge and charge
  if (['storage', 'spa'].includes(fam)) return anyAboveZero([u16(regs, I + 1014), u32(regs, I + 1054), u32(regs, I + 1058)]);
  if (fam === 'tl3') return false;
  return undefined;
};

/** A grid meter or CT: it measured grid power or energy at some point. */
const hasMeter = (regs, fam) => {
  // power to user and to grid, energy to user and to grid
  if (fam === 'tlx') return anyAboveZero([u32(regs, I + 3041), u32(regs, I + 3043), u32(regs, I + 3069), u32(regs, I + 3073)]);
  if (['storage', 'spa'].includes(fam)) return anyAboveZero([u32(regs, I + 1021), u32(regs, I + 1029), u32(regs, I + 1046), u32(regs, I + 1050)]);
  if (fam === 'tl3') return false;
  return undefined;
};

// read once per (re)start; a range the model lacks is refused, or left out after a timeout
const DETECT_BLOCKS = [
  ...IDENTITY,
  {
    start: 3000, count: 125, input: true, optional: true,
  },
  {
    start: 3125, count: 125, input: true, optional: true,
  },
  {
    start: 0, count: 125, input: true, optional: true,
  },
  {
    start: 1000, count: 125, input: true, optional: true,
  },
];

/** A fact not read is left out, so its stored verdict stands (ModbusDevice.runDetection). */
const detect = (regs, previous = {}) => {
  const fam = familyOf(regs) || previous.family;
  const dtc = dtcOf(regs);
  const ratedPower = ratedPowerOf(regs);
  const detected = {
    ...(fam ? { family: fam } : {}),
    ...(dtc ? { dtc } : {}),
    ...trackers(regs),
    ...(ratedPower ? { ratedPower } : {}),
  };
  const battery = hasBattery(regs, fam);
  if (battery !== undefined) detected.hasBattery = battery;
  const meter = hasMeter(regs, fam);
  if (meter !== undefined) detected.hasMeter = meter;
  // kept: a battery added later changes the side only through a repair
  const side = previous.solarSide || solarSide({ ...previous, ...detected });
  return { ...detected, ...(side ? { solarSide: side } : {}) };
};

const common = {
  port: 502,
  unitId: 1,
  usesUnitId: true, // the inverter's Modbus address, 1 unless changed on the inverter
  readGapMs: 100,
  pollInterval: 10,
  identity,
  detectBlocks: () => DETECT_BLOCKS,
  detect,
};

// --- inverter -----------------------------------------------------------------------------

const AC_INVERTER_CAPABILITIES = ['measure_power.ac_inverter', 'meter_power.ac_inverter'];

/**
 * Holding 3: active power rate in %, 255 = not limited. Back to its initial value at power-on
 * unless holding 2 is set (V1.39), so reapply writes it again after the inverter restarted.
 */
const ACTIVE_POWER_RATE = 3;
const NO_LIMIT = 255;

/** The limit this app set in %, null when not limited. */
const heldLimit = (device) => {
  const wanted = device.getStoreValue('powerLimit');
  return typeof wanted === 'number' && wanted < 100 ? wanted : null;
};

const inverter = {
  ...common,
  identityBlocks: () => IDENTITY,
  pairable: (regs) => Boolean(str(regs, 23, 5)) && !unsupportedModel(regs) && MODELS[dtcOf(regs)]?.[0] !== 'spa',
  blocks: (base, detected) => {
    // up to the temperature (3093 / 93); battery power only, the battery device reads the rest
    const blocks = [{ start: 0, count: 8 }]; // on/off, active power rate, rated power
    if (detected.family === 'tlx') {
      blocks.push({ start: 3000, count: 94, input: true });
      if (detected.hasBattery) blocks.push({ start: 3178, count: 4, input: true });
    }
    if (['storage', 'tl3'].includes(detected.family)) blocks.push({ start: 0, count: 94, input: true });
    if (detected.family === 'storage' && detected.hasBattery) blocks.push({ start: 1009, count: 4, input: true });
    return blocks;
  },
  capabilities: {
    measure_power: solarPower,
    target_power: (regs, device) => {
      const rate = u16(regs, ACTIVE_POWER_RATE);
      const rated = device.detected.ratedPower;
      if (rate === undefined || !(rated > 0)) return undefined;
      return Math.round((Math.min(rate, 100) / 100) * rated);
    },
    'measure_power.dc_solar': (regs, device) => inverterData(regs, device).ppv,
    'measure_power.ac_inverter': (regs, device) => inverterData(regs, device).pac,
    measure_efficiency: efficiency,
    meter_power: solarEnergyTotal,
    'meter_power.today': solarEnergyToday,
    // includes battery discharge
    'meter_power.ac_inverter': (regs, device) => tenths(regs, at(device, 3051, 55), 2),
    measure_temperature: (regs, device) => round(scale(i16(regs, at(device, 3093, 93)), 10), 1),
    'measure_voltage.1': phaseVoltage(1),
    'measure_voltage.2': phaseVoltage(2),
    'measure_voltage.3': phaseVoltage(3),
    'measure_current.1': phaseCurrent(1),
    'measure_current.2': phaseCurrent(2),
    'measure_current.3': phaseCurrent(3),
    measure_frequency: (regs, device) => round(scale(u16(regs, at(device, 3025, 37)), 100), 2),
    ...pvStrings(),
    alarm_problem: inFault,
  },

  capabilityOptions: (detected) => {
    const options = {};
    const side = solarSide(detected);
    if (side) for (const cap of ['meter_power', 'meter_power.today']) options[cap] = { title: solarTitle(cap, side) };
    if (detected.ratedPower > 0) {
      options.target_power = { min: 0, max: detected.ratedPower, step: Math.max(1, Math.round(detected.ratedPower / 100)) };
    }
    return options;
  },

  controls: [
    {
      capabilities: ['target_power'],
      // whole percents of the rated power; 100 % is written as "not limited"
      write: async ({ client, device, values }) => {
        const rated = device.detected.ratedPower;
        if (!(rated > 0)) throw Error(device.homey.__('errors.notSupported'));
        const pct = Math.round(Math.max(0, Math.min(1, Number(values.target_power) / rated)) * 100);
        await client.writeRegister(ACTIVE_POWER_RATE, pct >= 100 ? NO_LIMIT : pct);
        await device.setStoreValue('powerLimit', pct);
      },
      reapply: async ({ client, device, regs }) => {
        const wanted = heldLimit(device);
        const current = u16(regs, ACTIVE_POWER_RATE);
        if (wanted === null || current === undefined || current === wanted) return;
        device.log(`active power rate is ${current}, writing ${wanted} % again`);
        await client.writeRegister(ACTIVE_POWER_RATE, wanted);
      },
      // on delete only: after an app restart reapply writes the limit again
      release: async ({ client, device, deleted }) => {
        if (deleted && heldLimit(device) !== null) await client.writeRegister(ACTIVE_POWER_RATE, NO_LIMIT);
      },
    },
  ],

  // switched off for the night: a PV-only inverter takes the X2 on its USB port with it (not verified)
  unreachable: () => ({
    measure_power: 0,
    'measure_power.dc_solar': 0,
    'measure_power.ac_inverter': 0,
    measure_efficiency: null,
    ...Object.fromEntries(Array.from({ length: PV_STRINGS }, (_, i) => [`measure_power.pv${i + 1}`, 0])),
  }),

  unsupported: (detected) => {
    const drop = [];
    if (!detected.hasBattery) drop.push(...AC_INVERTER_CAPABILITIES);
    if (!(detected.ratedPower > 0)) drop.push('target_power');
    const strings = Number.isInteger(detected.strings) ? detected.strings : PV_STRINGS;
    for (let n = strings + 1; n <= PV_STRINGS; n += 1) drop.push(...pvStringCapabilities(n));
    if (detected.phases === 1) drop.push('measure_voltage.2', 'measure_voltage.3', 'measure_current.2', 'measure_current.3');
    return drop;
  },
};

// --- battery ------------------------------------------------------------------------------

/** Below this, charge or discharge power counts as idle. */
const BATTERY_IDLE_BAND_W = 10;

const batteryNet = (regs, device) => {
  const { charge, discharge } = batteryPower(regs, device);
  if (charge === undefined || discharge === undefined) return undefined;
  return charge - discharge;
};

const battery = {
  ...common,
  identityBlocks: () => [
    ...IDENTITY,
    // tlx: BDC connect state, then total discharge and charge; V1.24 ranges end at 3124
    {
      start: 3118, count: 7, input: true, optional: true,
    },
    {
      start: 3125, count: 8, input: true, optional: true,
    },
    {
      start: 1014, count: 46, input: true, optional: true,
    }, // storage: SoC, total discharge and charge
  ],
  pairable: (regs) => !unsupportedModel(regs) && [hasBattery(regs, 'tlx'), hasBattery(regs, 'storage')].includes(true),
  // from the first register read to the SoH (3222 / 1096)
  blocks: (base, detected) => {
    if (detected.family === 'tlx') return [{ start: 3127, count: 96, input: true }];
    if (['storage', 'spa'].includes(detected.family)) return [{ start: 1009, count: 88, input: true }];
    return [{ start: 0, count: 8 }];
  },
  capabilities: {
    // > 0 charging, as Homey
    measure_power: batteryNet,
    measure_battery: (regs, device) => u16(regs, at(device, 3171, 1014)),
    battery_charging_state: (regs, device) => {
      const net = batteryNet(regs, device);
      if (net === undefined) return undefined;
      if (net > BATTERY_IDLE_BAND_W) return 'charging';
      if (net < -BATTERY_IDLE_BAND_W) return 'discharging';
      return 'idle';
    },
    'meter_power.charged': counter('meter_power.charged', 3131, 1058),
    'meter_power.discharged': counter('meter_power.discharged', 3127, 1054),
    // tlx 0.01 V, storage 0.1 V
    measure_voltage: (regs, device) => (family(device) === 'tlx'
      ? round(scale(u16(regs, I + 3169), 100), 1)
      : round(scale(u16(regs, I + 1013), 10), 1)),
    /*
     * tlx: BMS cell maximum temperature (0.1 °C). storage: 1040 is documented as 0.1 °C, but reads
     * whole degrees on an SPH (Homey forum topic 45487, #686).
     */
    measure_temperature: (regs, device) => (family(device) === 'tlx'
      ? round(scale(i16(regs, I + 3218), 10), 1)
      : i16(regs, I + 1040)),
    // 0 while the BMS does not report it; SoH moves over months, so the last value stays
    measure_soh: (regs, device) => u16(regs, at(device, 3222, 1096)) || undefined,
  },
};

// --- meter --------------------------------------------------------------------------------

const meter = {
  ...common,
  identityBlocks: () => [
    ...IDENTITY,
    {
      start: 3041, count: 34, input: true, optional: true,
    }, // tlx: power and energy to user and to grid
    {
      start: 1021, count: 31, input: true, optional: true,
    }, // storage: power and energy to user and to grid
  ],
  pairable: (regs) => !unsupportedModel(regs) && [hasMeter(regs, 'tlx'), hasMeter(regs, 'storage')].includes(true),
  blocks: (base, detected) => {
    if (detected.family === 'tlx') return [{ start: 3041, count: 34, input: true }];
    if (['storage', 'spa'].includes(detected.family)) return [{ start: 1021, count: 31, input: true }];
    return [{ start: 0, count: 8 }];
  },
  capabilities: {
    // to user (import) minus to grid (export): > 0 importing, as Homey
    measure_power: (regs, device) => {
      const imported = tenths(regs, at(device, 3041, 1021), 0);
      const exported = tenths(regs, at(device, 3043, 1029), 0);
      if (imported === undefined || exported === undefined) return undefined;
      return imported - exported;
    },
    'meter_power.imported': counter('meter_power.imported', 3069, 1046),
    'meter_power.exported': counter('meter_power.exported', 3073, 1050),
  },
};

module.exports = {
  inverter, battery, meter, MODELS, familyOf, dtcOf,
};

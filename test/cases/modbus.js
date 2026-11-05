'use strict';

/* The local Modbus drivers outside Homey, against a fake Modbus TCP server per register family:
   manifests against the point map, pairing (with its detection), a first start without migration,
   decoded values, and the power limit control. Register values are synthetic, from the protocol
   documents' layout (lib/growattModbusPointMap.js). */

const {
  DRIVERS, manifest, brand, homey, logs, registerCapture, INPUT, serve, pairAndStart, stop,
} = require('../modbus-harness');

// --- fake inverters -----------------------------------------------------------------------

const ascii = (text) => Array.from({ length: text.length / 2 }, (_, i) => text.charCodeAt(2 * i) * 256 + text.charCodeAt(2 * i + 1));
const u32 = (value) => [Math.floor(value / 0x10000), value % 0x10000];
const put = (map, address, words) => words.forEach((w, i) => {
  map[address + i] = w;
});

/** Holding 0-124 as the documents lay it out; `dtc43` in 43, trackers/phases in 44. */
const holdingBlock = ({
  serial, dtc43, tp, pmax,
}) => {
  const h = {};
  for (let a = 0; a < 125; a += 1) h[a] = 0;
  put(h, 3, [100]); // not limited (a MIN TL-XH starts at 100)
  put(h, 6, u32(pmax * 10));
  put(h, 9, ascii('DM1.0 ZBAA'.padEnd(12, ' ')));
  put(h, 23, ascii(serial));
  put(h, 43, [dtc43, tp]);
  return h;
};

const fill = (map, start, count) => {
  for (let a = start; a < start + count; a += 1) if (map[a] === undefined) map[a] = 0;
};

const MIN_XH = (() => {
  const holding = {
    ...holdingBlock({
      serial: 'MXH1234567', dtc43: 0, tp: 0x0201, pmax: 5000,
    }),
    30000: 5100,
  };
  // battery settings as on a MIN 6000TL-XH with APX: period 1 battery first 00:05-23:55, BDC 2.5 kW
  fill(holding, 3000, 125);
  put(holding, 3036, [100, 10, 0xa005, 0x1737]);
  put(holding, 3047, [100, 100, 0]);
  put(holding, 3111, [25]);
  put(holding, 122, [1, 1000]); // export limitation by an RS485 meter, at 100 %
  const input = {};
  put(input, 3000, [1]); // normal
  put(input, 3001, u32(30000)); // PV 3000 W
  put(input, 3003, [3500, 45, ...u32(16000), 3400, 41, ...u32(14000)]); // PV1, PV2
  put(input, 3023, u32(25000)); // AC 2500 W
  put(input, 3025, [5000, 2301, 108]);
  put(input, 3041, [...u32(1000), ...u32(4000), ...u32(15000)]); // to user 100 W, to grid 400 W, load
  put(input, 3049, [...u32(123), ...u32(45678), ...u32(51234)]); // Eac today, Eac total, Epv total
  put(input, 3069, u32(9876)); // to user total 987.6 kWh
  put(input, 3073, u32(5432)); // to grid total 543.2 kWh
  put(input, 3083, u32(150)); // Epv today 15.0 kWh
  put(input, 3093, [452]);
  put(input, 3118, [1]); // BDC1 connected
  put(input, 3127, u32(3210)); // discharged total 321.0 kWh
  put(input, 3131, u32(3456)); // charged total 345.6 kWh
  put(input, 3169, [4015, 0, 67]); // 401.5 V, SoC 67 %
  put(input, 3178, [...u32(0), ...u32(4500)]); // charging 450 W
  put(input, 3218, [251]);
  put(input, 3222, [98]);
  fill(input, 3000, 250);
  return { holding, input };
})();

const SPH = (() => {
  const holding = holdingBlock({
    serial: 'SPH7654321', dtc43: 3502, tp: 0x0201, pmax: 6000,
  });
  const input = {};
  put(input, 0, [1, ...u32(20000)]);
  put(input, 35, u32(18000));
  put(input, 37, [5001, 2310, 80]);
  put(input, 53, [...u32(100), ...u32(2000)]);
  put(input, 59, u32(60)); // Epv1 today
  put(input, 63, u32(40)); // Epv2 today
  put(input, 91, u32(2500)); // Epv total
  put(input, 1009, [...u32(5000), ...u32(0), 520, 55]); // discharging 500 W, 52.0 V, SoC 55 %
  put(input, 1021, u32(2000)); // to user 200 W
  put(input, 1029, u32(0));
  put(input, 1040, [24]);
  put(input, 1046, u32(1111));
  put(input, 1050, u32(2222));
  put(input, 1054, u32(700));
  put(input, 1058, u32(800));
  fill(input, 0, 125);
  fill(input, 1000, 125);
  return { holding, input };
})();

const TL3 = (() => {
  const holding = holdingBlock({
    serial: 'TL3ABCDEFG', dtc43: 0, tp: 0x0203, pmax: 10000,
  });
  const input = {};
  put(input, 1, u32(40000));
  put(input, 35, u32(38000));
  put(input, 55, u32(99999));
  fill(input, 0, 125);
  return { holding, input };
})();

/** The capture blocks in the log, and whether each holds the registers the fake server serves. */
const capturesOf = (unit) => {
  const { captures, errors } = registerCapture.parseLog(logs.join('\n'));
  const asServed = Object.values(captures).every((capture) => [...registerCapture.fromRuns(capture.registers)]
    .every(([address, word]) => (address >= INPUT ? unit.input[address - INPUT] : unit.holding[address]) === word));
  return { captures, errors, asServed };
};

/** Export limit (holding 123, only with 122 on), status, temperature derating, fault codes. */
const exportAndStatus = async (t, unitCase, device, writes) => {
  const name = `${unitCase.name}: inverter`;
  const { holding, input } = unitCase.unit;
  const exportControl = brand.pointMap.inverter_modbus.controls.find((item) => item.capabilities.includes('export_limit'));
  writes.length = 0;
  await device.writeControl(exportControl, { export_limit: 0 });
  t.eq(JSON.stringify(writes), '[[123,0]]', `${name}: export limit 0 W writes 0 to 123`);
  writes.length = 0;
  await device.writeControl(exportControl, { export_limit: 0 });
  t.eq(writes.length, 0, `${name}: the same export limit writes nothing`);
  holding[122] = 0;
  const off = await device.writeControl(exportControl, { export_limit: 2500 }).then(() => null, (error) => error);
  t.ok(off?.refusal && /ShinePhone/.test(off.message), `${name}: refused while export limitation is off in the inverter`);
  Object.assign(holding, { 122: 1, 123: 1000 });

  Object.assign(input, {
    3000: 0x0503, 3086: 6, 3105: 302, 3106: 401,
  });
  await device.poll();
  t.eq(device.getCapabilityValue('running_state'), 'fault', `${name}: status from the low byte of 3000`);
  t.eq(device.getCapabilityValue('alarm_heat'), true, `${name}: temperature derating (3086 = 6) raises alarm_heat`);
  t.eq(device.getCapabilityValue('active_faults'), 'Fault code 302, Warning code 401', `${name}: fault and warning codes`);
  Object.assign(input, {
    3000: 1, 3086: 0, 3105: 0, 3106: 0,
  });
  await device.poll();
  t.eq(device.getCapabilityValue('active_faults'), null, `${name}: no codes clears active_faults`);
  device.problems.length = 0; // the refused export limit, not a poll problem
};

// --- battery control ----------------------------------------------------------------------

const control = brand.pointMap.battery_modbus.controls[0];
const MINUTE = 60 * 1000;

/** TL-XH without VPP: stored settings, so rounded, spaced, limited per day and written back. */
const legacyControl = async (t, unitCase, device, writes) => {
  const name = `${unitCase.name}: battery control without VPP`;
  const { holding } = unitCase.unit;
  t.ok(device.hasCapability('target_power_mode'), `${name}: offered (3111 gives ${device.detected.bdcPower} W)`);
  t.eq(device.detected.bdcPower, 2500, `${name}: battery power from BDC module 1 (3111)`);

  writes.length = 0;
  await device.writeControl(control, { target_power: 600 });
  t.eq(JSON.stringify(writes), '[[3038,[40960,5947]],[3047,20]]', `${name}: 600 W is battery first all day at 20 % (10 % steps of 2500 W)`);
  t.eq(device.getStoreValue('legacyOriginal')[3038], 0xa005, `${name}: the user's own period 1 is kept`);

  writes.length = 0;
  await device.writeControl(control, { target_power: 1200 });
  t.eq(writes.length, 0, `${name}: a new setpoint within 5 minutes waits`);
  await device.setStoreValue('storedWrites', [Date.now() - 6 * MINUTE]);
  await device.keepAlive();
  t.eq(JSON.stringify(writes), '[[3047,50]]', `${name}: the waiting setpoint is written after 5 minutes, only what changed`);

  writes.length = 0;
  await device.setStoreValue('storedWrites', [Date.now() - 6 * MINUTE]);
  await device.writeControl(control, { target_power: 1150 });
  t.eq(writes.length, 0, `${name}: a setpoint in the same 10 % step writes nothing`);

  await device.setStoreValue('storedWrites', Array.from({ length: 24 }, (_, i) => Date.now() - (i + 6) * MINUTE));
  const refused = await device.writeControl(control, { target_power_mode: 'force_discharge' }).then(() => null, (error) => error);
  t.ok(refused?.refusal && /a day/.test(refused.message), `${name}: refused after 24 writes in 24 hours`);
  t.eq(writes.length, 0, `${name}: nothing written over the daily limit`);

  await device.writeControl(control, { target_power_mode: 'self_consumption' });
  t.eq(JSON.stringify(writes), '[[3038,[40965,5943]],[3047,100]]', `${name}: self-consumption writes the user's settings back, also over the limit`);
  t.eq(device.getStoreValue('legacyOriginal'), null, `${name}: nothing left to write back`);

  // SoC limits: grid first stop SoC (3037) and battery first stop SoC (3048)
  await device.setStoreValue('storedWrites', []);
  t.eq(device.getCapabilityValue('battery_min_soc'), 0.1, `${name}: minimum SoC from 3037`);
  t.eq(device.getCapabilityValue('battery_max_soc'), 1, `${name}: maximum SoC from 3048`);
  writes.length = 0;
  await device.setSocLimits({ min: 20, max: 90 });
  t.eq(JSON.stringify(writes), '[[3037,20],[3048,90]]', `${name}: the SoC limits card writes 3037 and 3048`);
  writes.length = 0;
  await device.setSocLimits({ min: 20, max: 90 });
  t.eq(writes.length, 0, `${name}: the same SoC limits write nothing`);
  const outside = await device.setSocLimits({ min: 5, max: 90 }).then(() => null, (error) => error);
  t.ok(outside?.refusal, `${name}: a minimum below 10 % is refused`);
  Object.assign(holding, { 3037: 10, 3048: 100 });

  // another writer (the ShinePhone app) changes what this app wrote
  await device.setStoreValue('storedWrites', []);
  await device.writeControl(control, { target_power_mode: 'force_discharge' });
  t.eq(holding[3038], 0xc000, `${name}: force discharge is grid first all day`);
  holding[3036] = 50;
  device.controlEndedAt = 0;
  device.rereadBlocks();
  await device.poll();
  t.eq(device.getCapabilityValue('alarm_generic.control'), true, `${name}: a change made elsewhere raises the alarm`);
  t.eq(device.getStoreValue('remoteMode'), false, `${name}: and this app stops controlling`);
  // back as the user had it, for the cases after this one
  Object.assign(holding, {
    3036: 100, 3038: 0xa005, 3039: 0x1737, 3047: 100,
  });
};

/** VPP: control authority once, then the setpoint in 30407-30409, which are not stored. */
const vppControl = async (t) => {
  const name = 'MIN TL-XH with VPP: battery control';
  const unit = { holding: { ...MIN_XH.holding }, input: { ...MIN_XH.input } };
  put(unit.holding, 30099, [201]);
  put(unit.holding, 30100, [0]);
  put(unit.holding, 30404, [100, 10, 10, 0, 0, 0]);
  const { server, writes, port } = await serve(unit);
  try {
    const started = await pairAndStart('battery_modbus', port);
    t.ok(started, `${name}: offered`);
    if (!started) return;
    const { device } = started;
    t.eq(device.detected.vppControl, true, `${name}: VPP detected from 30099`);
    writes.length = 0;
    await device.writeControl(control, { target_power: -1250 });
    t.eq(JSON.stringify(writes), `[[30100,1],[30407,[1,5,${-50 & 0xffff}]]]`, `${name}: -1250 W is -50 % of 2500 W, for 5 minutes`);
    writes.length = 0;
    await device.writeControl(control, { target_power: 500 });
    t.eq(JSON.stringify(writes), '[[30407,[1,5,20]]]', `${name}: a new setpoint writes only 30407-30409`);
    writes.length = 0;
    await device.keepAlive();
    t.eq(JSON.stringify(writes), '[[30407,[1,5,20]]]', `${name}: kept alive`);
    writes.length = 0;
    await device.writeControl(control, { target_power_mode: 'self_consumption' });
    t.eq(JSON.stringify(writes), '[[30407,0],[30100,0]]', `${name}: self-consumption clears 30407 and 30100`);

    writes.length = 0;
    await device.setSocLimits({ min: 15, max: 95 });
    t.eq(JSON.stringify(writes), '[[30405,15],[30404,95]]', `${name}: the SoC limits card writes 30405 and 30404`);

    // another VPP holds control authority
    unit.holding[30100] = 1;
    writes.length = 0;
    const refused = await device.writeControl(control, { target_power_mode: 'force_charge' }).then(() => null, (error) => error);
    t.ok(refused?.refusal, `${name}: refused while another VPP has control authority`);
    t.eq(writes.length, 0, `${name}: nothing written then`);
    stop(device);
  } finally {
    server.close();
  }
};

module.exports = async (t) => {
  // manifests list exactly the point map's capabilities, in its order
  for (const id of DRIVERS) {
    const listed = manifest.drivers.find((item) => item.id === id).capabilities;
    const mapped = Object.keys(brand.pointMap[id].capabilities);
    t.ok(JSON.stringify(listed) === JSON.stringify(mapped), `${id}: manifest and point map list the same capabilities`);
  }

  const cases = [
    {
      name: 'MIN TL-XH',
      unit: MIN_XH,
      family: 'tlx',
      expect: {
        inverter_modbus: {
          'measure_power.dc_solar': 3000,
          'measure_power.ac_inverter': 2500,
          'meter_power.today': 15,
          'measure_voltage.pv2': 340,
          'measure_current.pv1': 4.5,
          'measure_power.pv1': 1600,
          measure_temperature: 45.2,
          target_power: 5000,
          export_limit: 5000,
          running_state: 'on_grid',
          alarm_problem: false,
          alarm_heat: false,
          active_faults: null,
        },
        battery_modbus: {
          measure_power: 450,
          measure_battery: 67,
          battery_charging_state: 'charging',
          'meter_power.charged': 345.6,
          'meter_power.discharged': 321,
          measure_voltage: 401.5,
          measure_soh: 98,
        },
        meter_modbus: { measure_power: -300, 'meter_power.imported': 987.6, 'meter_power.exported': 543.2 },
      },
      absent: { inverter_modbus: ['measure_power.pv3', 'measure_voltage.3'] },
    },
    {
      name: 'SPH (device type code in holding 43)',
      unit: SPH,
      family: 'storage',
      expect: {
        inverter_modbus: {
          'measure_power.dc_solar': 2000, 'measure_power.ac_inverter': 1800, meter_power: 250, 'meter_power.today': 10,
        },
        battery_modbus: {
          measure_power: -500, measure_battery: 55, measure_temperature: 24, 'meter_power.charged': 80,
        },
        meter_modbus: { measure_power: 200, 'meter_power.imported': 111.1, 'meter_power.exported': 222.2 },
      },
    },
    {
      name: 'TL3-X (family from the input range)',
      unit: TL3,
      family: 'tl3',
      expect: { inverter_modbus: { measure_power: 3800, meter_power: 9999.9 } },
      absent: { inverter_modbus: ['measure_power.ac_inverter'] },
      unpairable: ['battery_modbus', 'meter_modbus'],
    },
  ];

  for (const unitCase of cases) {
    const {
      server, writes, reads, port,
    } = await serve(unitCase.unit); // eslint-disable-line no-await-in-loop
    try {
      for (const id of DRIVERS) {
        logs.length = 0;
        reads.length = 0;
        const started = await pairAndStart(id, port); // eslint-disable-line no-await-in-loop
        const { captures, errors, asServed } = capturesOf(unitCase.unit);
        const prefix = id.replace(/[^A-Za-z]/g, '');
        t.eq(errors.join('; '), '', `${unitCase.name}: ${id} captures parse from the log`);
        t.ok(asServed, `${unitCase.name}: ${id} captures hold the registers as served`);
        t.ok(captures[`${prefix}PairIdentity`], `${unitCase.name}: ${id} pairing captures its identity registers`);
        if ((unitCase.unpairable || []).includes(id)) {
          t.ok(started === null, `${unitCase.name}: ${id} is not offered`);
          continue;
        }
        if (!unitCase.expect[id]) {
          if (started) stop(started.device);
          continue;
        }
        t.ok(started, `${unitCase.name}: ${id} is offered`);
        if (!started) continue;
        const { device, offer } = started;
        t.eq(offer.store.detected?.family, unitCase.family, `${unitCase.name}: ${id} detected family at pairing`);
        t.ok(Array.isArray(offer.capabilities), `${unitCase.name}: ${id} paired with its capabilities`);
        t.eq(device.migrations.join(' '), '', `${unitCase.name}: ${id} does not migrate right after pairing`);
        t.eq(device.problems.join('; '), '', `${unitCase.name}: ${id} started without problems`);
        // once at pairing (identity, reused by detection), once at the start (detection, reused by identity)
        t.eq(reads.filter((read) => read === '3:0:125').length, 2, `${unitCase.name}: ${id} reads its identity block twice, not four times`);
        for (const [cap, value] of Object.entries(unitCase.expect[id])) {
          t.eq(device.getCapabilityValue(cap), value, `${unitCase.name}: ${id} ${cap}`);
        }
        for (const cap of (unitCase.absent || {})[id] || []) {
          t.ok(!device.hasCapability(cap), `${unitCase.name}: ${id} has no ${cap}`);
        }
        for (const kind of ['PairDetection', 'Identity', 'Detection', 'Poll']) {
          t.ok(captures[`${prefix}${kind}`], `${unitCase.name}: ${id} captures ${kind}`);
        }
        t.eq(JSON.stringify(captures[`${prefix}Poll`]?.values), JSON.stringify(device.values), `${unitCase.name}: ${id} Poll capture holds the values`);
        if (id === 'inverter_modbus' && unitCase.unit === MIN_XH) {
          writes.length = 0;
          const control = brand.pointMap[id].controls[0];
          await device.writeControl(control, { target_power: 2500 }); // eslint-disable-line no-await-in-loop
          t.eq(JSON.stringify(writes), '[[3,50]]', `${unitCase.name}: a 2500 W limit writes 50 % to holding 3`);
          unitCase.unit.holding[3] = 100; // the inverter restarted
          await device.poll(); // eslint-disable-line no-await-in-loop
          t.eq(JSON.stringify(writes), '[[3,50],[3,50]]', `${unitCase.name}: a limit lost in a restart is written again`);
          await device.writeControl(control, { target_power: 5000 }); // eslint-disable-line no-await-in-loop
          t.eq(JSON.stringify(writes[2]), '[3,100]', `${unitCase.name}: the rated power writes "not limited"`);
          await device.poll(); // eslint-disable-line no-await-in-loop
          t.eq(writes.length, 3, `${unitCase.name}: no limit is reapplied once unlimited`);
          await exportAndStatus(t, unitCase, device, writes); // eslint-disable-line no-await-in-loop

          // off for the night: power 0 rather than the last reading, one logged failure per hour
          const { readBlocks } = device;
          device.readBlocks = async () => {
            throw Error('connect ECONNREFUSED');
          };
          for (let n = 0; n < 6; n += 1) await device.poll(); // eslint-disable-line no-await-in-loop
          t.ok(!device.getAvailable(), `${unitCase.name}: unreachable makes the inverter unavailable`);
          t.eq(device.getCapabilityValue('measure_power'), 0, `${unitCase.name}: unreachable sets solar power to 0`);
          t.eq(device.getCapabilityValue('measure_power.pv1'), 0, `${unitCase.name}: unreachable sets string power to 0`);
          t.eq(device.getCapabilityValue('measure_efficiency'), null, `${unitCase.name}: unreachable clears the efficiency`);
          t.eq(device.problems.filter((line) => line.includes('failed:')).length, 3, `${unitCase.name}: failed polls are logged until unavailable`);
          device.readBlocks = readBlocks;
          device.problems.length = 0;
        }
        if (id === 'battery_modbus' && unitCase.unit === MIN_XH) await legacyControl(t, unitCase, device, writes);
        stop(device);
      }
    } finally {
      server.close();
    }
  }
  await vppControl(t);
  homey.app.pool.destroy();
};

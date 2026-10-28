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
  put(h, 3, [255]); // not limited
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
  put(input, 3169, [5230, 0, 67]); // 52.3 V, SoC 67 %
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
          alarm_problem: false,
        },
        battery_modbus: {
          measure_power: 450,
          measure_battery: 67,
          battery_charging_state: 'charging',
          'meter_power.charged': 345.6,
          'meter_power.discharged': 321,
          measure_voltage: 52.3,
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
    const { server, writes, port } = await serve(unitCase.unit); // eslint-disable-line no-await-in-loop
    try {
      for (const id of DRIVERS) {
        logs.length = 0;
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
          await device.writeControl(control, { target_power: 5000 }); // eslint-disable-line no-await-in-loop
          t.eq(JSON.stringify(writes[1]), '[3,255]', `${unitCase.name}: the rated power writes "not limited"`);
        }
        stop(device);
      }
    } finally {
      server.close();
    }
  }
  homey.app.pool.destroy();
};

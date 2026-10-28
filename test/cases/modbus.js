'use strict';

/* The local Modbus drivers outside Homey, against a fake Modbus TCP server per register family:
   manifests against the point map, pairing (with its detection), a first start without migration,
   decoded values, and the power limit control. Register values are synthetic, from the protocol
   documents' layout (lib/growattModbusPointMap.js). */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const requireStubbed = require('../stubs');

const ROOT = path.join(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8'));
const DRIVERS = ['inverter_modbus', 'battery_modbus', 'meter_modbus'];

class SimpleClass {

  log() {}

  error() {}

}

class Device extends SimpleClass {

  constructor({ driver, offer, homey }) {
    super();
    this.homey = homey;
    this.driver = driver;
    this.data = offer.data;
    this.settings = { ...offer.settings };
    this.store = structuredClone(offer.store || {});
    this.values = Object.fromEntries((offer.capabilities || driver.manifest.capabilities).map((id) => [id, null]));
    this.energy = driver.manifest.energy ?? null;
    this.available = true;
    this.migrations = [];
    this.problems = [];
  }

  getName() {
    return this.driver.id;
  }

  getData() {
    return this.data;
  }

  getSettings() {
    return this.settings;
  }

  getSetting(key) {
    return this.settings[key];
  }

  async setSettings(settings) {
    Object.assign(this.settings, settings);
  }

  hasCapability(id) {
    return id in this.values;
  }

  getCapabilities() {
    return Object.keys(this.values);
  }

  getCapabilityValue(id) {
    return this.values[id] ?? null;
  }

  async addCapability(id) {
    this.migrations.push(`+${id}`);
    this.values[id] = null;
  }

  async removeCapability(id) {
    this.migrations.push(`-${id}`);
    delete this.values[id];
  }

  getCapabilityOptions(id) {
    if (!this.options?.[id]) throw new Error(`Invalid Capability: ${id}`);
    return this.options[id];
  }

  async setCapabilityOptions(id, options) {
    this.options = { ...this.options, [id]: options };
  }

  getEnergy() {
    return this.energy;
  }

  async setEnergy(energy) {
    this.energy = energy;
  }

  async setCapabilityValue(id, value) {
    if (!(id in this.values)) throw new Error(`Invalid Capability: ${id}`);
    this.values[id] = value;
  }

  getStoreValue(key) {
    return this.store[key] ?? null;
  }

  async setStoreValue(key, value) {
    this.store[key] = value;
  }

  getAvailable() {
    return this.available;
  }

  async setAvailable() {
    this.available = true;
  }

  async setUnavailable(message) {
    this.available = false;
    this.problems.push(`unavailable: ${message}`);
  }

  registerMultipleCapabilityListener() {}

  error(...args) {
    this.problems.push(`error: ${args.map((arg) => arg?.message ?? arg).join(' ')}`);
  }

}

const stubs = { homey: { Device, Driver: SimpleClass, SimpleClass } };
const ModbusPool = requireStubbed(path.join(ROOT, 'lib', 'ModbusPool.js'), stubs);
const brand = requireStubbed(path.join(ROOT, 'lib', 'modbusBrand.js'), stubs);

const homey = {
  manifest,
  __: (key) => key.split('.').reduce((node, part) => node?.[part], en) ?? key,
  i18n: { getLanguage: () => 'en' },
  setTimeout: () => ({}),
  clearTimeout() {},
  setInterval: () => ({}),
  clearInterval() {},
  on() {},
  removeListener() {},
  settings: { get: () => undefined, set() {} },
  app: { pool: new ModbusPool() },
};

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

/** Answers 0x03/0x04 inside the given registers, exception 2 outside; 0x06 writes into holding. */
const serve = (unit) => new Promise((resolve) => {
  const writes = [];
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.on('data', (frame) => {
      const fc = frame.readUInt8(7);
      const address = frame.readUInt16BE(8);
      if (fc === 0x06) {
        unit.holding[address] = frame.readUInt16BE(10);
        writes.push([address, frame.readUInt16BE(10)]);
        socket.write(Buffer.from(frame.subarray(0, 12)));
        return;
      }
      const count = frame.readUInt16BE(10);
      const map = fc === 0x04 ? unit.input : unit.holding;
      const words = Array.from({ length: count }, (_, i) => map[address + i]);
      if (words.some((w) => w === undefined)) {
        const reply = Buffer.alloc(9);
        frame.copy(reply, 0, 0, 4);
        reply.writeUInt16BE(3, 4);
        reply.writeUInt8(frame.readUInt8(6), 6);
        reply.writeUInt8(fc | 0x80, 7);
        reply.writeUInt8(2, 8);
        socket.write(reply);
        return;
      }
      const reply = Buffer.alloc(9 + count * 2);
      frame.copy(reply, 0, 0, 4);
      reply.writeUInt16BE(3 + count * 2, 4);
      reply.writeUInt8(frame.readUInt8(6), 6);
      reply.writeUInt8(fc, 7);
      reply.writeUInt8(count * 2, 8);
      words.forEach((w, i) => reply.writeUInt16BE(w, 9 + i * 2));
      socket.write(reply);
    });
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, writes, port: server.address().port }));
});

const loadDriver = (id) => {
  const DriverClass = requireStubbed(path.join(ROOT, 'drivers', id, 'driver.js'), stubs);
  const driver = new DriverClass();
  driver.homey = homey;
  driver.id = id;
  driver.manifest = manifest.drivers.find((item) => item.id === id);
  driver.getDevices = () => [];
  return driver;
};

const settle = async (device) => {
  while (device.polling) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 5); // eslint-disable-line homey-app/global-timers
    });
  }
};

/** Pair `id` from a scan hit at the fake server and start it; null when nothing is offered. */
const pairAndStart = async (id, port) => {
  const driver = loadDriver(id);
  driver.scanResults = async () => [{ id: null, address: '127.0.0.1', port }];
  const offers = await driver.onPairListDevices();
  if (!offers.length) return null;
  const [offer] = offers;
  const DeviceClass = requireStubbed(path.join(ROOT, 'drivers', id, 'device.js'), stubs);
  const device = new DeviceClass({ driver, offer, homey });
  await device.onInit();
  await settle(device);
  return { driver, device, offer };
};

const stop = (device) => {
  device.stopPolling();
  device.release();
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
        const started = await pairAndStart(id, port); // eslint-disable-line no-await-in-loop
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

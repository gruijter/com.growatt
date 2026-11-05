'use strict';

/* The local Modbus drivers outside Homey: a Device stub, a fake Modbus TCP server, and pairing and
   starting a driver against it. Shared by cases/modbus.js and cases/modbus-replay.js; every log
   line of drivers and devices lands in `logs`, as in a diagnostics report. */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const requireStubbed = require('./stubs');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8'));
const DRIVERS = ['inverter_modbus', 'battery_modbus', 'meter_modbus'];
const logs = [];

class SimpleClass {

  log(...args) {
    logs.push(args.join(' '));
  }

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
const registerCapture = requireStubbed(path.join(ROOT, 'lib', 'registerCapture.js'), stubs);
const { INPUT } = requireStubbed(path.join(ROOT, 'lib', 'registers.js'), stubs);

const homey = {
  manifest,
  __: (key, tokens = {}) => String(key.split('.').reduce((node, part) => node?.[part], en) ?? key)
    .replace(/__(\w+)__/g, (match, token) => (token in tokens ? tokens[token] : match)),
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

/** Answers 0x03/0x04 inside the given registers, exception 2 outside; 0x06 and 0x10 write into holding. */
const serve = (unit) => new Promise((resolve) => {
  const writes = [];
  const reads = [];
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
      if (fc === 0x10) {
        const words = Array.from({ length: frame.readUInt16BE(10) }, (_, i) => frame.readUInt16BE(13 + i * 2));
        words.forEach((word, i) => {
          unit.holding[address + i] = word;
        });
        writes.push([address, words]);
        const reply = Buffer.from(frame.subarray(0, 12));
        reply.writeUInt16BE(6, 4);
        socket.write(reply);
        return;
      }
      const count = frame.readUInt16BE(10);
      reads.push(`${fc}:${address}:${count}`);
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
  server.listen(0, '127.0.0.1', () => resolve({
    server, writes, reads, port: server.address().port,
  }));
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

module.exports = {
  ROOT, manifest, DRIVERS, logs, homey, brand, registerCapture, INPUT, serve, pairAndStart, stop,
};

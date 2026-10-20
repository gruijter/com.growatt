'use strict';

/* A datalogger that went offline leaves its last record, all zeros, in the cloud. That record must
   make the device unavailable and leave its capabilities alone; a live one must not. */

const Module = require('node:module');
const fixtures = require('../fixtures');
const growattMap = require('../../lib/growattMap');

const loadDevice = () => {
  const orig = Module._load;
  Module._load = function load(req, parent, isMain) {
    if (req === 'homey') return { Device: class {} };
    return orig.call(this, req, parent, isMain);
  };
  try {
    return require('../../lib/common_device.js');
  } finally {
    Module._load = orig;
  }
};

const MOVED_TO_MIN = 'Nick.van.koningsveld@gmail.com';

const fakeDevice = (Device, growatt) => {
  const dev = Object.create(Device.prototype);
  const state = { available: true, message: null, set: {} };
  Object.assign(dev, {
    state,
    driver: { id: 'inverter2' },
    deviceType: 'inv',
    deviceSn: 'QUH4BK90AK',
    growatt,
    invalidCapsLogged: new Set(),
    homey: { __: (key, tokens) => `${key}:${tokens ? tokens.since || tokens.type : ''}` },
    log: () => {},
    error: () => {},
    getName: () => 'test',
    getSettings: () => ({}),
    getStoreValue: () => false,
    setStoreValue: async () => {},
    hasCapability: () => true,
    setAvailable: async () => {
      state.available = true; state.message = null;
    },
    setUnavailable: async (message) => {
      state.available = false; state.message = message;
    },
    setCapabilityValue: async (cap, value) => {
      state.set[cap] = value;
    },
  });
  return dev;
};

module.exports = async (t) => {
  if (!fixtures.available) return t.skip('no zzz_responses/ - run `node zzz_collect.js` to capture');
  const Device = loadDevice();

  const net = fixtures.install();
  try {
    let lost = 0;
    let live = 0;
    for (const dev of fixtures.devices().filter((d) => d.deviceType === 'inv')) {
      const g = fixtures.client(dev.account);
      // eslint-disable-next-line no-await-in-loop
      const lastData = await g.getLastData({ deviceSn: dev.deviceSn, deviceType: dev.deviceType });
      const entry = ((lastData && lastData.inv) || []).find((d) => growattMap.deviceSnOf(d) === dev.deviceSn);
      if (!entry) continue;
      // judged at capture time: the archive ages, the payloads do not
      const capturedAt = Date.parse(fixtures.fixture(dev.account, '/v4/new-api/queryLastData', { deviceSn: dev.deviceSn, deviceType: 'inv' }).capturedAt);
      const run = async (growatt) => {
        const realNow = Date.now;
        Date.now = () => capturedAt;
        const d = fakeDevice(Device, growatt);
        d.deviceSn = dev.deviceSn;
        try {
          await d.handleLastData(entry);
        } finally {
          Date.now = realNow;
        }
        return d;
      };
      // eslint-disable-next-line no-await-in-loop
      // the client's limiter waits on Date.now, so the list is fetched before the clock is set back
      const listOf = async (client) => {
        const list = await client.getDeviceList2({}).catch(() => undefined);
        return { getDeviceList2: async () => list };
      };
      // eslint-disable-next-line no-await-in-loop
      const d = await run(await listOf(g));
      if (entry.time && entry.time.startsWith('2026-05-09')) {
        lost += 1;
        t.ok(!d.state.available, `${dev.deviceSn}: a record from months ago makes the device unavailable`);
        t.eq(d.state.message, `status.staleData:${entry.time}`, `${dev.deviceSn}: without a device list, the message names when data stopped`);
        t.eq(Object.keys(d.state.set).length, 0, `${dev.deviceSn}: no capability is overwritten with the stale zeros`);
        // the same serial's live account lists it as min now
        // eslint-disable-next-line no-await-in-loop
        const moved = await run(await listOf(fixtures.client(MOVED_TO_MIN)));
        t.eq(moved.state.message, 'status.deviceTypeChanged:min', `${dev.deviceSn}: listed as min, so the message asks for a repair`);
        t.eq(Object.keys(moved.state.set).length, 0, `${dev.deviceSn}: and still writes nothing`);
      } else {
        live += 1;
        t.ok(d.state.available, `${dev.deviceSn}: a fresh record keeps the device available`);
        t.ok(Object.keys(d.state.set).length > 0, `${dev.deviceSn}: and sets its capabilities`);
      }
    }
    if (!lost) t.log('no lost inverter in the archive');
    t.ok(live > 0, `${live} live inverter(s) checked`);
  } finally {
    net.restore();
  }
};

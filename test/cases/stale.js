'use strict';

/* A datalogger that went offline leaves its last record, all zeros, in the cloud. That record must
   make the device unavailable and leave its capabilities alone; a live one must not. */

const requireStubbed = require('../stubs');
const fixtures = require('../fixtures');
const growattMap = require('../../lib/growattMap');

const loadDevice = () => requireStubbed(require.resolve('../../lib/common_device.js'), { homey: { Device: class {} } });

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

const DAY = 24 * 60 * 60 * 1000;

// synthetic: no capture needed
async function clockCases(t, Device) {
  const realNow = Date.now;
  let now = 1792462237436;
  Date.now = () => now;
  try {
    const d = fakeDevice(Device, { getDeviceList2: async () => ({ data: [] }) });
    d.deviceType = 'min';
    // a datalogger clock ten days behind: the first record looks stale, the next upload clears it
    await d.handleLastData({ calendar: now - (10 * DAY), time: 'x' });
    t.ok(!d.state.available, 'first record dated ten days back: unavailable');
    now += 6 * 60 * 1000;
    await d.handleLastData({ calendar: now - (10 * DAY) + (6 * 60 * 1000), time: 'x' });
    t.ok(d.state.available, 'a datalogger clock days off recovers with its next upload');
    now += 6 * DAY;
    await d.handleLastData({ calendar: now - (16 * DAY) + (6 * 60 * 1000), time: 'x' });
    t.ok(d.state.available, 'the same upload for six days: still available');
    now += 2 * DAY;
    await d.handleLastData({ calendar: now - (18 * DAY) + (6 * 60 * 1000), time: 'x' });
    t.ok(!d.state.available, 'the same upload for eight days on Homey\'s clock: unavailable');
  } finally {
    Date.now = realNow;
  }
  Date.now = () => now;
  try {
    const d = fakeDevice(Device);
    d.deviceType = 'min';
    const record = {
      calendar: now - (3 * 60 * 60 * 1000), time: 'x', pac: 40, ppv: 42, epvTotal: 1000,
    };
    // after a restart at dusk, on a datalogger clock three hours behind
    await d.handleLastData(record);
    t.eq(d.state.set.measure_power, 40, 'a record first heard now is not asleep, whatever its own clock says');
    now += 19 * 60 * 1000;
    await d.handleLastData(record);
    t.eq(d.state.set.measure_power, 40, 'the same upload for 19 minutes: power kept');
    now += 2 * 60 * 1000;
    await d.handleLastData(record);
    t.eq(d.state.set.measure_power, 0, 'the same upload for 21 minutes: asleep, power 0');
    t.eq(d.state.set['measure_power.dc_solar'], 0, 'asleep: DC power 0 too');
    t.eq(d.state.set.meter_power, 1000, 'asleep: energy counters keep their value');
    now += 6 * 60 * 1000;
    await d.handleLastData({ ...record, calendar: record.calendar + (27 * 60 * 1000), pac: 5 });
    t.eq(d.state.set.measure_power, 5, 'a new upload wakes it');
    t.eq(d.state.set.alarm_connectivity, false, 'uploading again: no connection alarm');
    now += 23 * 60 * 60 * 1000;
    const quiet = { ...record, calendar: record.calendar + (27 * 60 * 1000), pac: 5 };
    await d.handleLastData(quiet);
    t.eq(d.state.set.alarm_connectivity, false, 'the same upload for 23 hours (a night): no connection alarm');
    t.eq(d.state.set.measure_power, 0, 'but asleep');
    now += 2 * 60 * 60 * 1000;
    await d.handleLastData(quiet);
    t.eq(d.state.set.alarm_connectivity, true, 'the same upload for 25 hours: connection alarm');
    t.ok(d.state.available, 'and still available: stale only after a week');
    now += 6 * 60 * 1000;
    await d.handleLastData({ ...quiet, calendar: quiet.calendar + (25 * 60 * 60 * 1000) });
    t.eq(d.state.set.alarm_connectivity, false, 'a new upload clears the connection alarm');

    // the time an upload was first heard survives a restart
    const store = {};
    const r = fakeDevice(Device);
    r.deviceType = 'min';
    r.getStoreValue = (key) => (key in store ? store[key] : null);
    r.setStoreValue = async (key, value) => {
      store[key] = value;
    };
    const night = { ...record, calendar: now - (6 * 60 * 60 * 1000) };
    await r.handleLastData(night);
    now += 30 * 60 * 1000;
    delete r.uploadSeen; // the device object after an app restart
    await r.handleLastData(night);
    t.eq(r.state.set.measure_power, 0, 'after a restart: an upload heard 30 minutes before it is still asleep');

    const m = fakeDevice(Device);
    m.driver = { id: 'meter2' };
    m.deviceType = 'min';
    await m.handleLastData({ calendar: now, pacToUserTotal: 300 });
    now += 30 * 60 * 1000;
    await m.handleLastData({ calendar: now - (30 * 60 * 1000), pacToUserTotal: 300 });
    t.eq(m.state.set.measure_power, 300, 'a grid meter is never put to sleep');
  } finally {
    Date.now = realNow;
  }
  t.eq(growattMap.uploadTimeOf({ time: 1792462237436 }), 1792462237436, 'noah: the numeric `time` is its upload time');
  t.eq(growattMap.uploadTimeOf({ time: '2026-10-20 10:06:50' }), 0, 'a `time` string alone is no upload time');

  const p = fakeDevice(Device);
  p.getSettings = () => ({ username: 'u', token: 'new' });
  const polled = {
    username: 'u', token: 'new', deviceSn: 'QUH4BK90AK', deviceType: 'inv',
  };
  t.ok(p.pollIsForUs(polled), 'a poll with our serial, credentials and type is ours');
  t.ok(!p.pollIsForUs({ ...polled, token: 'old' }), 'a sibling still polling with the old token is not ours');
  t.ok(!p.pollIsForUs({ ...polled, deviceType: 'min' }), 'a poll for another type of our serial is not ours');
  t.ok(!p.pollIsForUs({ ...polled, deviceSn: 'OTHER' }), 'another serial is not ours');
}

module.exports = async (t) => {
  const Device = loadDevice();
  await clockCases(t, Device);
  if (!fixtures.available) return t.skip('no zzz_responses/ - run `node zzz_collect.js` to capture');

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

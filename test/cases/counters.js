'use strict';

/* Lifetime energy counters for Homey Energy: never falling, judged once per upload, and continued
   without a jump when the solar yield moves between its AC and DC counter. */

const requireStubbed = require('../stubs');

const loadDevice = () => requireStubbed(require.resolve('../../lib/common_device.js'), { homey: { Device: class {} } });

const fakeDevice = (Device, { driverId = 'inverter2', deviceType = 'min', store = {} } = {}) => {
  const dev = Object.create(Device.prototype);
  const state = { set: {}, store: { ...store }, restarts: 0 };
  Object.assign(dev, {
    state,
    driver: { id: driverId },
    deviceType,
    deviceSn: 'SN',
    invalidCapsLogged: new Set(),
    homey: { __: (key) => key, clock: { getTimezone: () => 'Europe/Amsterdam' } },
    log: () => {},
    error: () => {},
    getName: () => 'test',
    getSettings: () => ({}),
    getStoreValue: (key) => (key in state.store ? state.store[key] : null),
    setStoreValue: async (key, value) => {
      state.store[key] = value;
    },
    hasCapability: () => true,
    setAvailable: async () => {},
    setUnavailable: async () => {},
    setCapabilityValue: async (cap, value) => {
      state.set[cap] = value;
    },
    restartDevice: async () => {
      state.restarts += 1;
    },
  });
  return dev;
};

const MIN = 60 * 1000;

module.exports = async (t) => {
  const Device = loadDevice();
  const realNow = Date.now;
  let now = 1792462237436;
  Date.now = () => now;
  try {
    const d = fakeDevice(Device, { driverId: 'meter2', deviceType: 'min' });
    const record = (calendar, imported, exported) => ({
      calendar, etoUserTotal: imported, etoGridTotal: exported, pacToUserTotal: 0,
    });
    await d.handleLastData(record(now, 100, 50));
    t.eq(d.state.set['meter_power.imported'], 100, 'first reading as reported');

    // one low upload: held, and the cloud repeating it on later polls is still that one upload
    now += 6 * MIN;
    await d.handleLastData(record(now, 0, 50));
    t.eq(d.state.set['meter_power.imported'], 100, 'a single low upload is held');
    await d.handleLastData(record(now, 0, 50));
    await d.handleLastData(record(now, 0, 50));
    t.eq(d.state.set['meter_power.imported'], 100, 'the same low record polled again is not a second fall');
    now += 6 * MIN;
    await d.handleLastData(record(now, 101, 51));
    t.eq(d.state.set['meter_power.imported'], 101, 'the counter back: continues without an offset');

    // a real reset (two low uploads): continues from where it was
    now += 6 * MIN;
    await d.handleLastData(record(now, 1, 52));
    now += 6 * MIN;
    await d.handleLastData(record(now, 2, 53));
    t.eq(d.state.set['meter_power.imported'], 101, 'a reset counter continues where it was (growth over the two low uploads is lost)');
    now += 6 * MIN;
    await d.handleLastData(record(now, 3, 54));
    t.eq(d.state.set['meter_power.imported'], 102, 'and grows on from there');
    t.eq(d.state.set['meter_power.exported'], 54, 'the other counter is untouched');

    // the same low upload delivered twice at once (two polls ending together) is still one upload
    const race = fakeDevice(Device, { driverId: 'meter2', deviceType: 'min' });
    await race.handleLastData(record(now, 100, 50));
    now += 6 * MIN;
    await Promise.all([race.handleLastData(record(now, 0, 50)), race.handleLastData(record(now, 0, 50))]);
    now += 6 * MIN;
    await race.handleLastData(record(now, 101, 51));
    t.eq(race.state.set['meter_power.imported'], 101, 'a low upload delivered twice at once is held once, not counted as a fall');

    // a repair that moved the device to another type: its counters read other fields, no jump
    const moved = fakeDevice(Device, { driverId: 'meter2', deviceType: 'min' });
    await moved.handleLastData(record(now, 100, 50));
    moved.state.store.rebaseCounters = 'max';
    await moved.handleLastData(record(now, 100, 50));
    t.eq(moved.state.store.rebaseCounters, 'max', 'a record of the old type does not use up the rebase');
    moved.state.store.rebaseCounters = 'min';
    now += 6 * MIN;
    await moved.handleLastData(record(now, 500, 20));
    t.eq(moved.state.set['meter_power.imported'], 100, 'after a type-change repair a higher counter continues where it was');
    t.eq(moved.state.set['meter_power.exported'], 50, 'and so does a lower one');
    t.eq(moved.state.store.rebaseCounters, null, 'once');
    now += 6 * MIN;
    await moved.handleLastData(record(now, 501, 21));
    t.eq(moved.state.set['meter_power.imported'], 101, 'and grows on from there');

    // the net counter may fall: it is not held
    const net = fakeDevice(Device, { driverId: 'meter2', deviceType: 'storage' });
    const grid = (calendar, exported) => ({
      calendar, etoUserTotal: 10, etoGridTotal: exported, pacToUserTotal: 0,
    });
    await net.handleLastData(grid(now, 2));
    const first = net.state.set.meter_power;
    now += 6 * MIN;
    await net.handleLastData(grid(now, 5));
    now += 6 * MIN;
    await net.handleLastData(grid(now, 6));
    t.ok(first !== undefined && net.state.set.meter_power < first, `meter2's net meter_power may fall (${first} -> ${net.state.set.meter_power})`);

    // without an upload time nothing is held: a repeat cannot be told from a new record
    const blind = fakeDevice(Device, { driverId: 'meter2', deviceType: 'min' });
    await blind.handleLastData({ etoUserTotal: 100, pacToUserTotal: 0 });
    await blind.handleLastData({ etoUserTotal: 0, pacToUserTotal: 0 });
    t.eq(blind.state.set['meter_power.imported'], 0, 'no upload time: reported as is');

    // the battery verdict moves meter_power between the AC and the DC yield: no jump
    const inv = fakeDevice(Device, { store: { hasBattery: true } });
    const hybrid = {
      calendar: now, epvTotal: 1000, eacTotal: 1400, eChargeTotal: 5, pac: 0, ppv: 0,
    };
    await inv.handleLastData(hybrid);
    t.eq(inv.state.set.meter_power, 1000, 'with battery history: the DC yield');
    now += 6 * MIN;
    await inv.handleLastData({ ...hybrid, calendar: now, eChargeTotal: 0 });
    t.eq(inv.state.restarts, 1, 'no battery history any more: capabilities rebuilt');
    t.eq(inv.state.store.hasBattery, false, 'the verdict is stored');
    await inv.handleLastData({ ...hybrid, calendar: now, eChargeTotal: 0 });
    t.eq(inv.state.set.meter_power, 1000, 'the AC yield (1400) continues from the DC one, no jump');
    now += 6 * MIN;
    await inv.handleLastData({
      ...hybrid, calendar: now, eChargeTotal: 0, eacTotal: 1401,
    });
    t.eq(inv.state.set.meter_power, 1001, 'and then grows with it');
  } finally {
    Date.now = realNow;
  }
};

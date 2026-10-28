'use strict';

/* deviceHelpers.monotonic: few store writes while a counter grows, and no dip after a restart
   although the stored last reading lags (the capability value persists, the store does not keep up). */

const { monotonic, rebase } = require('../../lib/deviceHelpers');

const MIN = 60 * 1000;

/** A device as Homey keeps it: store and capability values survive a restart, memory does not. */
const fakeDevice = (kept = { store: {}, values: {} }) => {
  const writes = [];
  const device = {
    kept,
    writes,
    log: () => {},
    getName: () => 'test',
    getStoreValue: (key) => kept.store[key] ?? null,
    setStoreValue: async (key, value) => {
      writes.push(key);
      kept.store[key] = value;
    },
    hasCapability: (cap) => cap === 'meter_power',
    getCapabilityValue: (cap) => kept.values[cap] ?? null,
  };
  // as a device does with the result
  device.count = async (reading) => {
    const value = await monotonic(device, 'meter_power', reading);
    kept.values.meter_power = value;
    return value;
  };
  return device;
};

module.exports = async (t) => {
  const realNow = Date.now;
  let now = 1792462237436;
  Date.now = () => now;
  try {
    // growing every 10 s for an hour: the last reading is stored once per 15 minutes
    const d = fakeDevice();
    for (let n = 0; n < 360; n += 1) {
      await d.count(100 + n * 0.001); // eslint-disable-line no-await-in-loop
      now += 10 * 1000;
    }
    t.eq(d.writes.length, 4, 'an hour of growth every 10 s stores the last reading 4 times, not 360');
    t.eq(d.kept.values.meter_power, 100.359, 'and counts every reading');
    t.ok(d.kept.store.meter_powerLast < 100.359, 'the stored last reading lags');

    // restart: the stored reading is behind, the capability is not
    const r = fakeDevice(d.kept);
    t.eq(await r.count(100.359), 100.359, 'after a restart a counter that stood still shows the same');
    t.eq(r.kept.store.meter_powerOffset ?? null, null, 'and is no fall');
    t.eq(await r.count(100.4), 100.4, 'and counts on');

    // a real reset after a restart continues from what was shown, not from the stored reading
    now += 20 * MIN;
    const reset = fakeDevice(r.kept);
    reset.kept.values.meter_power = 100.5; // shown last, while the store still has an older reading
    t.eq(await reset.count(1), 100.5, 'a reset after a restart is held once');
    t.eq(await reset.count(2), 100.5, 'then continues from the shown value');
    t.eq(reset.kept.store.meter_powerLast, 2, 'and stores the fall at once');
    t.eq(await reset.count(3), 101.5, 'and grows on from there');

    // with offset: the shown value minus the offset is the last reading
    const o = fakeDevice({ store: { meter_powerLast: 10, meter_powerOffset: 50.3 }, values: { meter_power: 60.4 } });
    t.eq(await o.count(10.1), 60.4, 'with an offset a counter that stood still shows the same');

    // a tiny dip is held, not a fall, and is not stored
    const tiny = fakeDevice({ store: { meter_powerLast: 5 }, values: { meter_power: 5 } });
    t.eq(await tiny.count(4.9995), 5, 'a dip under 0.001 is held');
    t.eq(await tiny.count(4.9995), 5, 'also twice');
    t.eq(tiny.kept.store.meter_powerOffset ?? null, null, 'without an offset');

    // rebase uses the counted reading, not the lagging stored one
    const b = fakeDevice({ store: { meter_powerLast: 20 }, values: { meter_power: 20 } });
    await b.count(21);
    await b.count(22); // inside the save interval: not stored
    await rebase(b, 'meter_power', 500);
    t.eq(await b.count(501), 23, 'a rebase continues from the last reading counted, not the stored one');
  } finally {
    Date.now = realNow;
  }
};

'use strict';

/* The per-device poll scheduler on a virtual clock, against a server that refuses a repeat inside
   300 s: it must never break the rate limit and never miss an upload. */

const requireStubbed = require('../stubs');

const MyApp = requireStubbed(require.resolve('../../app.js'), { homey: { App: class {} }, growatt: class {} });
const T0 = 1788432000000;

// One 8-hour run. `skew`: payload clock vs real time; `clockErr`: Homey's own clock error.
async function simulate({
  offset = 0, cadence = 361000, deviceType = 'min', skew = 0, clockErr = 0, noTimestamp = false, nights = [], hours = 8,
}) {
  let now = T0;
  let timers = [];
  let seq = 0;
  const realNow = Date.now;
  Date.now = () => now + clockErr;

  const device = {
    username: 'u', token: 't', deviceSn: 'A', deviceType,
  };
  const app = Object.create(MyApp.prototype);
  app.log = () => {};
  app.error = () => {};
  app.devices = { [MyApp.pollKey(device)]: device };
  app.pollSchedules = {};
  app.homey = {
    setTimeout: (fn, ms) => {
      const id = ++seq; timers.push({ id, at: now + ms, fn }); return id;
    },
    clearTimeout: (id) => {
      timers = timers.filter((x) => x.id !== id);
    },
  };

  // `nights`: no uploads from `from` until `to`, then a new upload phase (the datalogger restarts)
  const latest = (t, start) => start + (Math.floor((t - start) / cadence) * cadence);
  const uploadAtOf = (t) => {
    let start = T0 + offset;
    for (const { from, to } of nights) {
      if (t < from) break;
      if (t < to) return latest(from - 1, start);
      start = to;
    }
    return latest(t, start);
  };

  const window = deviceType === 'noah' ? 60000 : 300000;
  let lastServed = -Infinity;
  const polls = [];
  let refusals = 0;
  app.pollDevice = async () => {
    const uploadAt = uploadAtOf(now);
    if (now - lastServed < window) {
      refusals += 1; return null;
    }
    lastServed = now;
    polls.push({ at: now, uploadAt, staleness: now - uploadAt });
    // noah carries its upload time as a numeric `time`, the others as `calendar`
    const stamp = deviceType === 'noah' ? { time: uploadAt + skew } : { calendar: uploadAt + skew };
    return { [deviceType]: [{ deviceSn: 'A', ...(noTimestamp ? {} : stamp) }] };
  };

  try {
    app.reconcileSchedules();
    while (now < T0 + (hours * 3600 * 1000)) {
      timers.sort((x, y) => x.at - y.at);
      const timer = timers.shift();
      if (!timer) break;
      now = timer.at;
      timer.fn();
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    }
  } finally {
    Date.now = realNow;
  }

  const uploads = new Set(polls.map((p) => p.uploadAt));
  const total = Math.floor((hours * 3600 * 1000) / cadence);
  const settled = polls.slice(6).map((p) => p.staleness);
  // the first hour after the last night: how stale its uploads were when picked up
  const dawn = nights.length ? nights[nights.length - 1].to : Infinity;
  const morning = polls.filter((p) => p.at >= dawn && p.at < dawn + 3600000 && p.uploadAt >= dawn);
  return {
    morningCaptured: new Set(morning.map((p) => p.uploadAt)).size,
    morningStale: Math.round(morning.slice(2).reduce((a, p) => a + p.staleness, 0) / Math.max(1, morning.length - 2) / 1000),
    refusals,
    captured: uploads.size,
    total,
    avgStale: Math.round(settled.reduce((a, b) => a + b, 0) / Math.max(1, settled.length) / 1000),
  };
}

module.exports = async (t) => {
  for (const offset of [0, 90000, 180000, 270000, 355000]) {
    const r = await simulate({ offset, skew: -6 * 3600 * 1000 });
    t.eq(r.refusals, 0, `cold start at +${offset / 1000}s never breaks the rate limit`);
    t.ok(r.captured >= r.total, `cold start at +${offset / 1000}s captures every upload (${r.captured}/${r.total})`);
    t.ok(r.avgStale <= 35, `cold start at +${offset / 1000}s settles at ${r.avgStale}s staleness`);
  }

  for (const skew of [0, -6 * 3600 * 1000, 8 * 3600 * 1000, -12600000]) {
    const r = await simulate({ offset: 200000, skew });
    t.ok(r.refusals === 0 && r.avgStale <= 35, `payload clock skew ${skew / 3600000}h: ${r.avgStale}s staleness, ${r.refusals} refusals`);
  }

  // a datalogger clock minutes off a quarter-hour: an early poll is still read as early, not as silence
  const minutesOff = await simulate({ offset: 0, skew: -((6 * 3600) + 420) * 1000 });
  t.ok(minutesOff.refusals === 0 && minutesOff.avgStale <= 35, `payload clock skew -6h7m: ${minutesOff.avgStale}s staleness, ${minutesOff.refusals} refusals`);

  for (const cadence of [340000, 361000, 400000]) {
    const r = await simulate({ offset: 200000, cadence, skew: -6 * 3600 * 1000 });
    t.ok(r.refusals === 0 && r.avgStale <= 40, `datalogger cadence ${cadence / 1000}s: ${r.avgStale}s staleness`);
  }

  const noah = await simulate({
    offset: 30000, cadence: 61000, deviceType: 'noah', skew: -6 * 3600 * 1000,
  });
  t.ok(noah.refusals === 0 && noah.captured >= noah.total, `noah on its 1-minute window: ${noah.captured}/${noah.total} uploads, ${noah.refusals} refusals`);

  // A wrong Homey clock must never cost correctness, only freshness
  for (const clockErr of [0, 200000, 450000, 900000, -1800000]) {
    const r = await simulate({ offset: 200000, skew: -6 * 3600 * 1000, clockErr });
    t.eq(r.refusals, 0, `Homey clock ${clockErr / 1000}s out: still no rate-limit breach`);
    t.ok(r.captured >= r.total - 1, `Homey clock ${clockErr / 1000}s out: still captures uploads (${r.captured}/${r.total})`);
  }

  // devices on one serial keep a schedule each, so repairing one of them takes effect
  const app = Object.create(MyApp.prototype);
  Object.assign(app, {
    log: () => {}, pollSchedules: {}, homey: { setTimeout: () => 1, clearTimeout: () => {} },
  });
  const inv = {
    username: 'u', token: 'new', host: 'h', deviceSn: 'A', deviceType: 'min',
  };
  const meter = { ...inv, token: 'old', deviceType: 'inv' };
  app.devices = { [MyApp.pollKey(inv)]: inv, [MyApp.pollKey(meter)]: meter };
  app.reconcileSchedules();
  t.eq(Object.keys(app.pollSchedules).length, 2, 'one serial with two credentials/types: two schedules');
  delete app.devices[MyApp.pollKey(meter)];
  app.reconcileSchedules();
  t.ok(Object.keys(app.pollSchedules).length === 1 && app.pollSchedules[MyApp.pollKey(inv)], 'the sibling repaired to the same identity: its old schedule stops, the other stays');

  // a night without uploads is silence, not a mistimed poll: the morning is picked up on time
  const HOUR = 3600 * 1000;
  for (const dawn of [0, 120000, 300000]) {
    const r = await simulate({ offset: 200000, skew: -6 * HOUR, nights: [{ from: T0 + (2 * HOUR), to: T0 + (6 * HOUR) + dawn }] });
    t.ok(r.refusals === 0 && r.morningStale <= 35, `after a night (dawn +${dawn / 1000}s): ${r.morningStale}s staleness, ${r.refusals} refusals`);
  }
  const nights = [0, 1, 2].map((d) => ({ from: T0 + ((d * 24) + 10) * HOUR, to: T0 + ((d * 24) + 20) * HOUR + (d * 70000) }));
  const week = await simulate({
    offset: 200000, skew: -6 * HOUR, nights, hours: 3 * 24,
  });
  t.ok(week.refusals === 0 && week.morningStale <= 35, `after three nights: ${week.morningStale}s staleness, ${week.refusals} refusals`);

  const blind = await simulate({ offset: 200000, noTimestamp: true });
  t.ok(blind.refusals === 0 && blind.captured >= blind.total, `payload without a timestamp falls back to fixed interval (${blind.captured}/${blind.total}, ${blind.avgStale}s)`);
};

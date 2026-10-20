'use strict';

/* The per-device poll scheduler on a virtual clock, against a server that refuses a repeat inside
   300 s: it must never break the rate limit and never miss an upload. */

const Module = require('node:module');

function loadApp() {
  const orig = Module._load;
  Module._load = function load(req, parent, isMain) {
    if (req === 'homey') return { App: class {} };
    if (req === 'growatt') return class {};
    return orig(req, parent, isMain);
  };
  try {
    return require('../../app.js');
  } finally {
    Module._load = orig;
  }
}

const MyApp = loadApp();
const T0 = 1788432000000;

// One 8-hour run. `skew`: payload clock vs real time; `clockErr`: Homey's own clock error.
async function simulate({
  offset = 0, cadence = 361000, deviceType = 'min', skew = 0, clockErr = 0, noTimestamp = false,
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
  app.devices = { A: device };
  app.pollSchedules = {};
  app.homey = {
    setTimeout: (fn, ms) => {
      const id = ++seq; timers.push({ id, at: now + ms, fn }); return id;
    },
    clearTimeout: (id) => {
      timers = timers.filter((x) => x.id !== id);
    },
  };

  const window = deviceType === 'noah' ? 60000 : 300000;
  let lastServed = -Infinity;
  const polls = [];
  let refusals = 0;
  app.pollDevice = async () => {
    const n = Math.floor((now - T0 - offset) / cadence);
    const uploadAt = T0 + offset + (n * cadence);
    if (now - lastServed < window) {
      refusals += 1; return null;
    }
    lastServed = now;
    polls.push({ at: now, uploadAt, staleness: now - uploadAt });
    return { [deviceType]: [{ deviceSn: 'A', ...(noTimestamp ? {} : { calendar: uploadAt + skew }) }] };
  };

  app.reconcileSchedules();
  while (now < T0 + (8 * 3600 * 1000)) {
    timers.sort((x, y) => x.at - y.at);
    const timer = timers.shift();
    if (!timer) break;
    now = timer.at;
    timer.fn();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  }
  Date.now = realNow;

  const uploads = new Set(polls.map((p) => p.uploadAt));
  const total = Math.floor((8 * 3600 * 1000) / cadence);
  const settled = polls.slice(6).map((p) => p.staleness);
  return {
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

  const blind = await simulate({ offset: 200000, noTimestamp: true });
  t.ok(blind.refusals === 0 && blind.captured >= blind.total, `payload without a timestamp falls back to fixed interval (${blind.captured}/${blind.total}, ${blind.avgStale}s)`);
};

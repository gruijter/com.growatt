'use strict';

/* The rate limiter and response cache, keyed on the exact request (account, endpoint, parameters). */

const Api = require('../../lib/growatt_api');

const stub = () => {
  const calls = [];
  let tripOn = null;
  global.fetch = async (url, options) => {
    calls.push(options?.body || '');
    const trip = tripOn && String(options?.body || '').includes(tripOn);
    return {
      status: 200,
      headers: { get: (h) => (h === 'content-type' ? 'application/json' : null), getSetCookie: () => [] },
      text: async () => JSON.stringify(trip
        ? { code: 102, message: 'FREQUENTLY_ACCESS' }
        : { error_code: 0, data: { min: { X: {} } } }),
    };
  };
  return {
    calls,
    trip: (sn) => {
      tripOn = sn;
    },
  };
};

const res = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, reason: e.reason }));
const mk = (host) => new Api({ user_name: 'u', token: 't', host: host || 'openapi.growatt.com' });

module.exports = async (t) => {
  const realFetch = global.fetch;
  Api.__testHooks.reset();
  Api.__testHooks.setSpacing(0);
  const net = stub();
  try {
    const a = mk();
    t.ok((await res(a.getLastData({ deviceSn: 'A', deviceType: 'min' }))).ok, 'request A succeeds');
    t.ok((await res(a.getLastData({ deviceSn: 'B', deviceType: 'min' }))).ok, 'request B succeeds');
    t.eq(net.calls.length, 2, 'two distinct requests both reach the network');

    // a second client of the same account answers a repeat from the shared cache
    const b = mk();
    net.calls.length = 0;
    t.ok((await res(b.getLastData({ deviceSn: 'A', deviceType: 'min' }))).ok, 'a second client answers a repeat from the shared cache');
    t.eq(net.calls.length, 0, 'and never touches the network');

    net.calls.length = 0;
    t.ok((await res(b.getLastData({ deviceSn: 'C', deviceType: 'min' }))).ok, 'a different request still goes through');
    t.eq(net.calls.length, 1, 'and it did reach the network');

    net.calls.length = 0;
    t.ok((await res(b.getLastData({ deviceType: 'min', deviceSn: 'C' }))).ok, 'reordered parameters are the same request');
    t.eq(net.calls.length, 0, 'so they are served from cache');

    // a different host is a different backend: caching across them would let discoverHost pick wrong
    net.calls.length = 0;
    t.ok((await res(mk('openapi-us.growatt.com').getLastData({ deviceSn: 'A', deviceType: 'min' }))).ok, 'another host is probed for real');
    t.eq(net.calls.length, 1, 'not answered from the first host cache');

    // a server trip is scoped to the request that earned it
    net.trip('deviceSn=D');
    const c = mk();
    const d1 = await res(c.getLastData({ deviceSn: 'D', deviceType: 'min' }));
    t.ok(!d1.ok && d1.reason === 'RATE_LIMITED', 'D trips at the server');
    t.ok((await res(c.getLastData({ deviceSn: 'E', deviceType: 'min' }))).ok, 'E succeeds immediately after');
    const d2 = await res(mk().getLastData({ deviceSn: 'D', deviceType: 'min' }));
    t.ok(!d2.ok && d2.reason === 'RATE_LIMITED', 'D stays refused for its own window');
    t.ok(c.lastDataCooldownUntil({ deviceSn: 'D', deviceType: 'min' }) > 0, 'D reports a cooldown');
    t.eq(c.lastDataCooldownUntil({ deviceSn: 'Z', deviceType: 'min' }), 0, 'an unrelated device reports none');
  } finally {
    global.fetch = realFetch;
    Api.__testHooks.setSpacing(1000);
    Api.__testHooks.reset();
  }
};

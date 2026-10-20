'use strict';

/* Every captured request, replayed through the real client, returns what was captured. */

const fixtures = require('../fixtures');

module.exports = async (t) => {
  if (!fixtures.available) return t.skip('no zzz_responses/ - run `node zzz_collect.js` to capture');

  const net = fixtures.install();
  try {
    const entries = fixtures.entries();
    const byAccount = new Map();
    entries.forEach((e) => byAccount.set(e.account, fixtures.client(e.account)));

    const call = {
      '/v1/user/check_user': (g) => g.checkUser(),
      '/v1/plant/user_plant_list': (g) => g.getPlantListUser(),
      '/v1/plant/list': (g) => g.getPlantList(),
      '/v1/plant/data': (g, r) => g.getPlantData({ plant_id: r.plant_id }),
      '/v1/plant/details': (g, r) => g.getPlantDetails({ plant_id: r.plant_id }),
      '/v1/device/list': (g, r) => g.getDeviceList({ plant_id: r.plant_id }),
      '/v1/device/datalogger/list': (g, r) => g.getDataLoggerList({ plant_id: r.plant_id }),
      '/v4/new-api/queryDeviceList': (g) => g.getDeviceList2({}),
      '/v4/new-api/queryDeviceInfo': (g, r) => g.getDeviceInfo({ deviceSn: r.deviceSn, deviceType: r.deviceType }),
      '/v4/new-api/queryLastData': (g, r) => g.getLastData({ deviceSn: r.deviceSn, deviceType: r.deviceType }),
      '/v4/new-api/readPower': (g, r) => g.getActivePower({ deviceSn: r.deviceSn, deviceType: r.deviceType }),
      '/v4/new-api/readVppParameter': (g, r) => g.getVPP({ deviceSn: r.deviceSn, deviceType: r.deviceType, setType: r.setType }),
    };

    let replayed = 0;
    let reasonsKept = 0;
    for (const e of entries) {
      const fn = call[e.endpoint];
      if (!fn) continue;
      const g = byAccount.get(e.account);
      // eslint-disable-next-line no-await-in-loop
      const got = await fn(g, e.request).then((r) => ({ r }), (err) => ({ err }));
      if (e.ok) {
        if (got.err) {
          t.ok(false, `${e.account} ${e.name}: replay threw ${got.err.message}`); continue;
        }
        replayed += 1;
      } else {
        if (!got.err) {
          t.ok(false, `${e.account} ${e.name}: captured an error but replay succeeded`); continue;
        }
        reasonsKept += 1;
      }
    }
    t.ok(replayed > 0, `${replayed} successful responses replayed`);
    t.ok(reasonsKept > 0, `${reasonsKept} captured failures replayed as failures`);
    t.ok(net.missing.length === 0, `every replayed request found its fixture (${net.missing.length} missing)`);
    t.ok(net.calls.length > 0 && net.calls.every((c) => c.url.startsWith('https://')), 'all traffic went through the stub');
    t.log(`${replayed} ok + ${reasonsKept} error fixtures, ${net.calls.length} intercepted requests`);
  } finally {
    net.restore();
  }
};

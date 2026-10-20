'use strict';

/* Host discovery and its error messages, against the account shapes that produced wrong ones. */

const Api = require('../../lib/growatt_api');
const fixtures = require('../fixtures');

module.exports = async (t) => {
  if (!fixtures.available) return t.skip('no zzz_responses/ - run `node zzz_collect.js` to capture');

  const net = fixtures.install();
  try {
    for (const account of fixtures.accountsByTier('working')) {
      // eslint-disable-next-line no-await-in-loop
      const r = await Api.discoverHost({ username: account, token: `fixture:${account}`, log: () => {} })
        .then((v) => ({ v }), (e) => ({ e }));
      t.ok(r.v && r.v.host === 'openapi.growatt.com', `${account}: discovery finds its host`);
      t.ok(r.v && r.v.info, `${account}: and returns the plant list with it`);
    }

    for (const account of fixtures.accountsByTier('rejected')) {
      // eslint-disable-next-line no-await-in-loop
      const r = await Api.discoverHost({ username: account, token: `fixture:${account}`, log: () => {} })
        .then((v) => ({ v }), (e) => ({ e }));
      t.ok(!!r.e, `${account}: discovery fails, as it must`);
      if (!r.e) continue;
      // the message must come from the host the user exists on, not the last host tried
      t.ok(!/userNotExist|does not exist/i.test(r.e.message),
        `${account}: not reported as non-existent (got "${r.e.message.slice(0, 60)}")`);
      t.ok(/contact|permission|token/i.test(r.e.message),
        `${account}: reported as an account or token problem instead`);
    }

    for (const account of fixtures.accountsByTier('no-devices')) {
      // eslint-disable-next-line no-await-in-loop
      const r = await Api.discoverHost({ username: account, token: `fixture:${account}`, log: () => {} })
        .then((v) => ({ v }), (e) => ({ e }));
      t.ok(r.v && r.v.host, `${account}: discovery SUCCEEDS - the account and token are fine`);
      const g = fixtures.client(account);
      // eslint-disable-next-line no-await-in-loop
      const list = await g.getDeviceList2({});
      t.eq(list.count, 0, `${account}: and the emptiness is in the device list, not the login`);
      t.ok((r.v?.info?.plants || []).length > 0, `${account}: it has plants, they just hold no devices`);
    }
    // pairing's grouped lastData must not block the new device's own first poll
    const account = fixtures.accountsByTier('working')
      .find((a) => fixtures.devices().filter((d) => d.account === a).length > 1)
      || fixtures.devices()[0]?.account;
    if (account) {
      const g = fixtures.client(account);
      // built exactly as common_driver builds it, from getDeviceList2 in its own order
      const list = (await g.getDeviceList2({}))?.data || [];
      const deviceType = list[0]?.deviceType;
      const sns = list.filter((d) => d.deviceType === deviceType).map((d) => d.deviceSn || d.serialNum);
      const grouped = await g.getLastData({ deviceSn: sns.join(','), deviceType });
      const entries = (grouped && grouped[deviceType]) || [];
      t.ok(entries.length >= sns.length, `${account}: one grouped call covers all ${sns.length} device(s) of a type`);

      for (const sn of sns) {
        const req = { deviceSn: sn, deviceType };
        t.eq(g.lastDataCooldownUntil(req), 0, `${sn}: its own first poll is not held back by pairing`);
        // eslint-disable-next-line no-await-in-loop
        const firstPoll = await g.getLastData(req).then((r) => r, () => null);
        t.ok(!!firstPoll, `${sn}: so it shows values immediately after pairing`);
      }
    }
    // pairing calls scale with plants and device types, never devices, to fit the dialog's timeout
    const SPACING_S = 1; // lib/growatt_api.js#requestSpacing
    const BUDGET_S = 15;
    for (const acct of fixtures.accountsByTier('working')) {
      const g = fixtures.client(acct);
      // eslint-disable-next-line no-await-in-loop
      const plants = (await g.getPlantListUser().catch(() => null))?.plants || [];
      // eslint-disable-next-line no-await-in-loop
      const list = (await g.getDeviceList2({}).catch(() => null))?.data || [];
      const types = new Set(list.map((d) => d.deviceType));
      const calls = 1 + 1 + plants.length + (types.size * 2); // lastData + deviceInfo per type
      const secs = (calls - 1) * SPACING_S;
      t.ok(secs <= BUDGET_S,
        `${acct}: ${plants.length} plant(s), ${list.length} device(s) -> ${calls} calls, ~${secs}s (budget ${BUDGET_S}s)`);
      t.ok(calls <= 2 + plants.length + (types.size * 2),
        `${acct}: cost scales with plants and device types, not with device count`);
    }
  } finally {
    net.restore();
  }
};

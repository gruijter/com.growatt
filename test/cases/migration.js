'use strict';

/* A freshly paired inverter2 must get the capability set it settles on, in order, so the first poll
   does not trigger a migration. */

const fixtures = require('../fixtures');
const growattMap = require('../../lib/growattMap');

module.exports = async (t) => {
  if (!fixtures.available) return t.skip('no zzz_responses/ - run `node zzz_collect.js` to capture');

  const net = fixtures.install();
  try {
    let checked = 0;
    for (const dev of fixtures.devices()) {
      const g = fixtures.client(dev.account);
      // eslint-disable-next-line no-await-in-loop
      const lastData = await g.getLastData({ deviceSn: dev.deviceSn, deviceType: dev.deviceType });
      const entry = ((lastData && lastData[dev.deviceType]) || [])
        .find((d) => growattMap.deviceSnOf(d) === dev.deviceSn);
      if (!entry) continue;

      // what pairing now hands over
      const hasBattery = growattMap.hasBatteryHistory(entry);
      const paired = Object.keys(growattMap.inverterCapabilities(dev.deviceType, hasBattery) || {});
      // what common_device#capabilityMap will ask for once the verdict is stored
      const stored = hasBattery === undefined ? null : hasBattery;
      const settled = Object.keys(growattMap.inverterCapabilities(dev.deviceType, stored === null ? undefined : stored) || {});

      // order too: a rebuild loses the Insights history of every capability after the mismatch
      t.ok(JSON.stringify(paired) === JSON.stringify(settled),
        `${dev.deviceSn} (${dev.deviceType}, hasBattery=${hasBattery}): paired set matches the settled set, in order`);

      // a string inverter must not be paired with the raw hybrid set
      const rawMap = Object.keys(growattMap.inverter2Map[dev.deviceType] || {});
      if (hasBattery === false) {
        t.ok(JSON.stringify(paired) !== JSON.stringify(rawMap),
          `${dev.deviceSn}: a string inverter is NOT paired with the raw hybrid set`);
      } else {
        t.ok(JSON.stringify(paired) === JSON.stringify(rawMap),
          `${dev.deviceSn}: an undetermined or hybrid device keeps the full set`);
      }
      checked += 1;
    }
    t.ok(checked > 0, `${checked} devices checked against their settled capability set`);
  } finally {
    net.restore();
  }
};

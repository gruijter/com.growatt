'use strict';

/* A freshly paired device must arrive with the capability set it will settle on. When it does not,
   the first poll settles the battery verdict, common_device#migrate rebuilds the set and the
   device sits in "waiting for migration" - which every string inverter did, because pairing handed
   over the full hybrid set regardless. */

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

      // Membership and ORDER both: migrate() rebuilds from the first mismatching index, so a
      // reordering destroys Insights history for every capability after it.
      t.ok(JSON.stringify(paired) === JSON.stringify(settled),
        `${dev.deviceSn} (${dev.deviceType}, hasBattery=${hasBattery}): paired set matches the settled set, in order`);

      // The assertion above holds by construction now, so it alone would pass even if the fix were
      // reverted. This is the one that fails in that case: before, pairing handed over the raw map
      // for every device, and a string inverter's verdict then removed two capabilities and added
      // one - three rebuilds, on six of ten devices here.
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

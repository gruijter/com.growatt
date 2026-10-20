'use strict';

/* Every captured payload through every capability map: no NaN, and no value changed against the
   snapshot recorded by the first run (zzz_responses/mapping-snapshot.json). */

const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('../fixtures');
const growattMap = require('../../lib/growattMap');

const SNAPSHOT = path.join(__dirname, '..', '..', 'zzz_responses', 'mapping-snapshot.json');
const DRIVERS = ['inverter2', 'meter2', 'battery2'];
const SETTINGS = {
  nominalPower: 5000, maxChargePower: 3000, maxDischargePower: 3000, efficiency: 98,
};

const describe = (v) => {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 'NaN';
  return v;
};

module.exports = async (t) => {
  if (!fixtures.available) return t.skip('no zzz_responses/ - run `node zzz_collect.js` to capture');

  const net = fixtures.install();
  const current = {};
  let mapped = 0;
  let nan = 0;
  try {
    for (const dev of fixtures.devices()) {
      const g = fixtures.client(dev.account);
      // eslint-disable-next-line no-await-in-loop
      const lastData = await g.getLastData({ deviceSn: dev.deviceSn, deviceType: dev.deviceType });
      const list = (lastData && lastData[dev.deviceType]) || [];
      const data = list.find((d) => growattMap.deviceSnOf(d) === dev.deviceSn);
      t.ok(!!data, `${dev.deviceSn} (${dev.deviceType}): payload found for this serial`);
      if (!data) continue;

      for (const driver of DRIVERS) {
        const caps = growattMap[`${driver}Map`]?.[dev.deviceType];
        if (!caps) continue;
        for (const [cap, entry] of Object.entries(caps)) {
          if (entry[0] !== 'getLastData' || !entry[1]) continue;
          const key = `${dev.deviceType}|${dev.deviceSn}|${driver}|${cap}`;
          let value;
          try {
            value = describe(entry[1](data, SETTINGS));
          } catch (e) {
            t.ok(false, `${key}: mapper threw ${e.message}`);
            continue;
          }
          current[key] = value;
          mapped += 1;
          if (value === 'NaN') nan += 1;
        }
      }
    }

    t.ok(mapped > 0, `${mapped} capability values mapped across ${fixtures.devices().length} devices`);
    t.log(`${nan} of ${mapped} map to NaN (a field the device does not report)`);

    if (!fs.existsSync(SNAPSHOT)) {
      fs.writeFileSync(SNAPSHOT, JSON.stringify(current, null, 2));
      t.log(`snapshot written: ${path.relative(process.cwd(), SNAPSHOT)} - rerun to compare against it`);
      return;
    }
    const before = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    const keys = new Set([...Object.keys(before), ...Object.keys(current)]);
    const changed = [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(current[k]));
    changed.slice(0, 20).forEach((k) => t.log(`  changed ${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(current[k])}`));
    t.ok(changed.length === 0, `no mapped value changed against the snapshot (${changed.length} differ)`);
  } finally {
    net.restore();
  }
};

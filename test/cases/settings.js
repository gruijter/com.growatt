'use strict';

/* Every setting a driver writes must be one that driver declares. */

const fs = require('node:fs');
const path = require('node:path');
const growattMap = require('../../lib/growattMap');

const DRIVERS = ['inverter2', 'meter2', 'battery2'];
const POWER_KEYS = ['nominalPower', 'maxChargePower', 'maxDischargePower'];

const declared = (driver) => {
  const file = path.join(__dirname, '..', '..', 'drivers', driver, 'driver.settings.compose.json');
  if (!fs.existsSync(file)) return null;
  const ids = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (typeof node.id === 'string') ids.push(node.id);
    Object.values(node).forEach(walk);
  };
  walk(JSON.parse(fs.readFileSync(file, 'utf8')));
  return ids;
};

module.exports = async (t) => {
  for (const driver of DRIVERS) {
    const ids = declared(driver);
    t.ok(!!ids, `${driver}: settings schema found`);
    if (!ids) continue;

    const wantsPower = growattMap.usesPowerSettings(driver);
    const declaresAnyPower = POWER_KEYS.some((k) => ids.includes(k));
    t.eq(wantsPower, declaresAnyPower,
      `${driver}: usesPowerSettings(${wantsPower}) agrees with what the schema declares (${POWER_KEYS.filter((k) => ids.includes(k)).join(', ') || 'none'})`);

    // target_power is the only consumer of a rated power, so only a driver that has it needs one
    const hasTargetPower = Object.values(growattMap[`${driver}Map`])
      .some((caps) => Object.keys(caps).includes('target_power'));
    if (hasTargetPower) {
      t.ok(ids.includes('nominalPower'), `${driver}: has target_power, so declares nominalPower`);
    }
    t.ok(ids.includes('model'), `${driver}: declares model, which every driver reads`);
  }

  // noah: W from the docs per model; an unknown model gets the higher limit
  const tp = (settings) => growattMap.targetPowerOptions('inverter2', settings);
  t.eq(tp({ deviceType: 'noah', model: 'NOAH2000 Master' }).max, 800, 'noah: 800 W (doc 4.3.2)');
  t.eq(tp({ deviceType: 'noah', model: 'NEXA 2000' }).max, 1000, 'nexa: 1000 W (doc 4.3.2)');
  t.eq(tp({ deviceType: 'noah', model: '' }).max, 1000, 'unknown noah model errs UPWARD, never capping the inverter');
  t.eq(tp({ deviceType: 'noah', model: 'Something New 3000' }).max, 1000, 'a future model too');
  t.eq(tp({ deviceType: 'min', nominalPower: 3300 }).max, 3300, 'other types still use their rated power');
  t.eq(tp({ deviceType: 'min' }).max, 3000, 'and fall back when it is unknown');

  // W in the capability, % on the wire: every slider position must survive the round trip
  t.eq(tp({ deviceType: 'min', nominalPower: 3300 }).step, 33, 'percentage devices step by 1% of rated power');
  t.eq(tp({ deviceType: 'noah', model: 'NOAH2000 Master' }).step, 1, 'noah is watts end to end, so it steps by 1 W');

  const get = growattMap.inverter2Map.min.target_power[1];
  const set = growattMap.inverter2Map.min.target_power[2];
  const settings = { nominalPower: 3300 };
  const { max, step } = tp({ deviceType: 'min', ...settings });
  let drifted = 0;
  for (let w = 0; w <= max; w += step) {
    if (get(set(w, settings).value, settings) !== w) drifted += 1;
  }
  t.eq(drifted, 0, `every one of the ${Math.floor(max / step) + 1} slider positions survives set-then-read unchanged`);

  const noahGet = growattMap.inverter2Map.noah.target_power[1];
  const noahSet = growattMap.inverter2Map.noah.target_power[2];
  t.eq(noahGet(Number(noahSet(457, {}).value), {}), 457, 'noah round-trips watts exactly, no conversion at all');
};

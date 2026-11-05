'use strict';

/* The register captures of real installations (zzz_responses/modbus/*.json, from
   test/from-modbus-logs.js), served by the fake Modbus server: each driver pairs and starts as it
   did there, with the same detection, and decodes the `expect` values. A driver the report has no
   device of is only reported: offered or not, which is what an unknown model needs looked at. */

const fs = require('node:fs');
const path = require('node:path');
const {
  ROOT, DRIVERS, homey, registerCapture, INPUT, serve, pairAndStart, stop,
} = require('../modbus-harness');

const DIR = path.join(ROOT, 'zzz_responses', 'modbus');

/** One fake unit from all captures, `id`'s own last so its poll is served as it was read. */
const unitOf = (captures, id) => {
  const prefix = id.replace(/[^A-Za-z]/g, '');
  const own = ['PairIdentity', 'PairDetection', 'Identity', 'Detection', 'Poll'].map((kind) => `${prefix}${kind}`);
  const order = [...Object.keys(captures).filter((name) => !own.includes(name)), ...own.filter((name) => captures[name])];
  const unit = { holding: {}, input: {} };
  for (const name of order) {
    for (const [address, word] of registerCapture.fromRuns(captures[name].registers)) {
      if (address >= INPUT) unit.input[address - INPUT] = word;
      else unit.holding[address] = word;
    }
  }
  return unit;
};

module.exports = async (t) => {
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')) : [];
  if (!files.length) return t.skip('no zzz_responses/modbus/ - run `node test/from-modbus-logs.js <report>`');

  for (const file of files) {
    const site = path.basename(file, '.json');
    const { captures, expect } = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
    for (const id of DRIVERS) {
      const prefix = id.replace(/[^A-Za-z]/g, '');
      const { server, port } = await serve(unitOf(captures, id)); // eslint-disable-line no-await-in-loop
      try {
        const started = await pairAndStart(id, port); // eslint-disable-line no-await-in-loop
        if (!expect[id]) {
          t.log(`${site}: ${id} ${started ? `offered (${JSON.stringify(started.offer.store.detected)})` : 'not offered'}`);
          if (started) stop(started.device);
          continue;
        }
        t.ok(started, `${site}: ${id} is offered`);
        if (!started) continue;
        const { device, offer } = started;
        const detected = (captures[`${prefix}Detection`] || captures[`${prefix}PairDetection`])?.detected;
        if (detected) {
          // a fact detection learned after the capture is new, not a difference
          const now = offer.store.detected;
          const same = Object.fromEntries(Object.keys(detected).map((key) => [key, now[key]]));
          t.eq(JSON.stringify(same), JSON.stringify(detected), `${site}: ${id} detects as it did`);
          const added = Object.keys(now).filter((key) => !(key in detected));
          if (added.length) t.log(`${site}: ${id} detects more now: ${added.map((key) => `${key}=${JSON.stringify(now[key])}`).join(', ')}`);
        }
        t.eq(device.migrations.join(' '), '', `${site}: ${id} does not migrate right after pairing`);
        t.eq(device.problems.join('; '), '', `${site}: ${id} started without problems`);
        for (const [cap, value] of Object.entries(expect[id])) {
          t.eq(device.getCapabilityValue(cap), value, `${site}: ${id} ${cap}`);
        }
        stop(device);
      } finally {
        server.close();
      }
    }
  }
  homey.app.pool.destroy();
  return undefined;
};

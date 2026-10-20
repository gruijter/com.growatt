'use strict';

/* A runner with no dependencies: every case file exports async (t) => {} and uses t.ok/t.eq.
   Run everything with `node test/run.js`, or one file with `node test/run.js mapping`. */

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, 'cases');
const filter = process.argv[2];

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function makeT(file) {
  return {
    ok(cond, msg) {
      if (cond) {
        passed += 1; return;
      }
      failed += 1;
      failures.push(`${file}: ${msg}`);
      console.log(`    FAIL  ${msg}`);
    },
    eq(actual, expected, msg) {
      this.ok(Object.is(actual, expected), `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
    },
    skip(msg) {
      skipped += 1; console.log(`    SKIP  ${msg}`);
    },
    log(msg) {
      console.log(`    ${msg}`);
    },
  };
}

(async () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && (!filter || f.includes(filter))).sort();
  for (const file of files) {
    console.log(`\n${file}`);
    const t = makeT(file);
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      await require(path.join(DIR, file))(t);
    } catch (e) {
      failed += 1;
      failures.push(`${file}: threw ${e.stack || e.message}`);
      console.log(`    FAIL  threw: ${e.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failures.length) console.log(`\n${failures.join('\n')}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

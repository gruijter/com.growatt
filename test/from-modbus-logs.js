'use strict';

/* Turn the Modbus register captures in a user's diagnostics report into a replay fixture.

     node test/from-modbus-logs.js <report.txt>              write zzz_responses/modbus/<site>.json
     node test/from-modbus-logs.js <report.txt> --site name  choose the file name
     node test/from-modbus-logs.js <report.txt> --dry        show what it found, write nothing
     node test/from-modbus-logs.js <report.txt> --force      overwrite a fixture that exists

   Reads the GROWATT-MODBUS blocks written by lib/registerCapture.js (pairing, device start and
   repair). The site defaults to the first serial number captured. `expect` starts as each device's
   captured Poll values; cases/modbus-replay.js compares a replay against it, so drop a value that
   depended on what the device had stored (a counter's previous reading) rather than on the registers. */

/* eslint-disable no-console */

const fs = require('node:fs');
const path = require('node:path');
const registerCapture = require('../lib/registerCapture');

const OUT = path.join(__dirname, '..', 'zzz_responses', 'modbus');
const DRIVERS = ['inverter_modbus', 'battery_modbus', 'meter_modbus'];
const args = process.argv.slice(2);
const option = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--site');
const dryRun = args.includes('--dry');
const force = args.includes('--force');

if (!file) {
  console.error('usage: node test/from-modbus-logs.js <report.txt> [--site name] [--dry] [--force]');
  process.exit(1);
}

const slug = (s) => String(s).replace(/[^a-zA-Z0-9._@-]/g, '_');

const { captures, errors } = registerCapture.parseLog(fs.readFileSync(file, 'utf8'));
errors.forEach((error) => console.error(`  skipped ${error}`));
const names = Object.keys(captures).sort();
if (!names.length) {
  console.error('no Modbus captures found');
  process.exit(1);
}

const expect = {};
for (const id of DRIVERS) {
  const poll = captures[`${id.replace(/[^A-Za-z]/g, '')}Poll`];
  if (poll) expect[id] = poll.values;
}
const serial = Object.values(captures).map((c) => c.identity?.serialNumber).find(Boolean);
const site = slug(option('--site') || serial || path.basename(file, path.extname(file)));
const target = path.join(OUT, `${site}.json`);

names.forEach((name) => {
  const c = captures[name];
  console.log(`  ${name} (${c.reason}, v${c.version}, ${Object.keys(c.registers || {}).length} run(s))`);
});
console.log(`devices with a poll: ${Object.keys(expect).join(', ') || 'none'}`);
if (fs.existsSync(target) && !force) {
  console.log(`exists  ${path.relative(process.cwd(), target)} (--force to overwrite)`);
} else if (!dryRun) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(target, JSON.stringify({
    capturedAt: new Date().toISOString(), source: path.basename(file), expect, captures,
  }, null, 2));
  console.log(`write   ${path.relative(process.cwd(), target)}`);
}

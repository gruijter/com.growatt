'use strict';

/* Turn a user's diagnostics report into replayable fixtures, as zzz_collect.js writes them.

     node test/from-logs.js <report.txt> --account <name>          write zzz_responses/<name>/*.json
     node test/from-logs.js <report.txt> --account <name> --dry    show what it found, write nothing
     node test/from-logs.js <report.txt> --account <name> --force  overwrite fixtures that exist

   Reads the capture blocks written by lib/growattCapture.js. The account name is only a folder and
   a key for test/fixtures.js#client(); a report carries no credentials. */

/* eslint-disable no-console */

const fs = require('node:fs');
const path = require('node:path');
const capture = require('../lib/growattCapture');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'zzz_responses');
const args = process.argv.slice(2);
const option = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--account');
const account = option('--account');
const dryRun = args.includes('--dry');
const force = args.includes('--force');

if (!file || !account) {
  console.error('usage: node test/from-logs.js <report.txt> --account <name> [--dry] [--force]');
  process.exit(1);
}

const slug = (s) => String(s).replace(/[^a-zA-Z0-9._@-]/g, '_');

// zzz_collect.js's file names
const fixtureName = ({ endpoint, request }) => {
  const name = capture.NAMES[endpoint];
  if (request.plant_id) return `plant_${request.plant_id}__${name}`;
  if (request.deviceSn && request.deviceSn.includes(',')) return `grouped__${request.deviceType}__${name}`;
  if (request.deviceSn) return `device__${request.deviceSn}__${name}${request.setType ? `__${request.setType}` : ''}`;
  return name;
};

const { captures, errors } = capture.parseLog(fs.readFileSync(file, 'utf8'));
errors.forEach((error) => console.error(`  skipped ${error}`));
if (!captures.length) {
  console.error('no captures found');
  process.exit(1);
}

// the last capture of a request wins: it is the most recent answer
const byName = new Map(captures.filter((c) => capture.NAMES[c.endpoint]).map((c) => [fixtureName(c), c]));
const indexFile = path.join(OUT, 'index.json');
const index = fs.existsSync(indexFile)
  ? JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  : {
    capturedAt: new Date().toISOString(), accounts: {}, tiers: {}, note: 'Replayable API fixtures.', entries: [],
  };
index.accounts[account] = index.accounts[account] || null; // no token, so no hash
index.tiers[account] = index.tiers[account] || 'report';

let written = 0;
for (const [name, c] of byName) {
  const target = path.join(OUT, slug(account), `${slug(name)}.json`);
  const rel = path.relative(ROOT, target);
  const exists = fs.existsSync(target);
  console.log(`${exists && !force ? 'exists ' : 'write  '} ${rel}${c.error ? ` (error ${c.error.reason})` : ''}`);
  if (dryRun || (exists && !force)) continue;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const outcome = c.error ? { error: c.error } : { response: c.response };
  fs.writeFileSync(target, JSON.stringify({
    capturedAt: new Date().toISOString(), account, endpoint: c.endpoint, request: c.request, ...outcome,
  }, null, 2));
  index.entries = index.entries.filter((e) => e.file !== rel);
  index.entries.push({
    account, tier: index.tiers[account], name, endpoint: c.endpoint, request: c.request, ok: !c.error, file: rel,
  });
  written += 1;
}
if (!dryRun && written) fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
console.log(`${captures.length} captures, ${byName.size} fixtures, ${written} written${dryRun ? ' (dry run)' : ''}`);

'use strict';

/* Replays captured API responses through a fetch stub, so the REAL client runs offline: its cache,
   its rate limiter, its parsing and the driver mapping on top. Nothing here mocks the client - the
   only thing replaced is the network.

   Fixtures live in zzz_responses/ (gitignored, they contain serial numbers and plant coordinates).
   Without them every case that needs one skips rather than fails, so the suite still runs on a
   fresh clone. Recapture with `node zzz_collect.js`. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const qs = require('node:querystring');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'zzz_responses');

// The parameters that identify WHICH response a request wants. user_name, page and perpage are
// deliberately absent: they ride along on every v1 call and never select between two fixtures.
const ID_KEYS = ['deviceSn', 'deviceType', 'setType', 'plant_id'];

const signature = (params) => ID_KEYS
  .filter((k) => params[k] !== undefined && params[k] !== '')
  .map((k) => `${k}=${params[k]}`)
  .join('&');

function load() {
  const indexFile = path.join(DIR, 'index.json');
  if (!fs.existsSync(indexFile)) return null;
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const byHash = new Map(Object.entries(index.accounts || {}).map(([acct, hash]) => [hash, acct]));
  const table = new Map(); // `${account}|${endpoint}|${signature}` -> fixture
  const loose = new Map(); // `${account}|${endpoint}` -> [fixture]
  for (const entry of index.entries) {
    const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, entry.file), 'utf8'));
    table.set(`${entry.account}|${entry.endpoint}|${signature(entry.request)}`, fixture);
    const key = `${entry.account}|${entry.endpoint}`;
    loose.set(key, [...(loose.get(key) || []), fixture]);
  }
  return {
    index, byHash, table, loose, count: index.entries.length,
  };
}

const store = load();

// Turn a captured fixture back into the wire body the client would have parsed. Errors are rebuilt
// from their REASON, not their message: the message is localized, the reason is the stable code the
// client branches on, and _mapApiError turns these strings back into exactly that reason.
function wireBody(fixture) {
  if (!fixture.error) return { error_code: 0, data: fixture.response };
  const raw = {
    RATE_LIMITED: 'FREQUENTLY_ACCESS',
    PERMISSION_DENIED: 'PERMISSION_DENIED',
  }[fixture.error.reason] || fixture.error.reason || fixture.error.message;
  return {
    code: fixture.error.errorCode ?? 1, error_code: fixture.error.errorCode ?? 1, error_msg: raw, message: raw,
  };
}

// Offline tests must not need real credentials. A token of `fixture:<account>` selects that
// account's captures directly; a real token still works, matched by hash, so the same harness can
// be pointed at the live API to check a fixture has not gone stale.
function accountFor(token) {
  const t = String(token || '');
  if (t.startsWith('fixture:')) return t.slice('fixture:'.length);
  return store.byHash.get(crypto.createHash('sha256').update(t).digest('hex').slice(0, 16));
}

function lookup(token, url, options) {
  const account = accountFor(token);
  if (!account) return null;
  const parsed = new URL(url);
  const endpoint = parsed.pathname;
  const params = { ...qs.parse(parsed.search.replace(/^\?/, '')), ...qs.parse(options?.body || '') };
  return store.table.get(`${account}|${endpoint}|${signature(params)}`)
    // exactly one capture for this endpoint means there is nothing to choose between
    || ((store.loose.get(`${account}|${endpoint}`) || []).length === 1
      ? store.loose.get(`${account}|${endpoint}`)[0] : null);
}

// Installs the stub and returns a handle: .calls counts what reached "the network", .restore undoes it.
function install() {
  // eslint-disable-next-line global-require
  const Api = require('../lib/growatt_api');
  // Start from nothing - reset() also detaches the persistence store, so a previous run's
  // cooldowns cannot leak in - and drop the 3-second politeness delay: it protects a live server,
  // and there is no server here. Without that a full replay would idle for several minutes.
  Api.__testHooks.reset();
  Api.__testHooks.setSpacing(0);
  const real = global.fetch;
  const state = { calls: [], missing: [] };
  global.fetch = async (url, options) => {
    const token = options?.headers?.token;
    const fixture = lookup(token, url, options);
    state.calls.push({ url: String(url), body: options?.body || null, hit: !!fixture });
    if (!fixture) {
      state.missing.push(`${new URL(url).pathname} ${options?.body || ''}`);
      // A miss is reported the way the server reports an unknown device, never as a hang
      return {
        status: 200,
        headers: { get: (h) => (h === 'content-type' ? 'application/json' : null), getSetCookie: () => [] },
        text: async () => JSON.stringify({ error_code: 10002, error_msg: 'FIXTURE_MISSING' }),
      };
    }
    return {
      status: 200,
      headers: { get: (h) => (h === 'content-type' ? 'application/json' : null), getSetCookie: () => [] },
      text: async () => JSON.stringify(wireBody(fixture)),
    };
  };
  state.restore = () => {
    global.fetch = real;
    Api.__testHooks.setSpacing(1000);
    Api.__testHooks.reset();
  };
  return state;
}

// Everything captured, so a case can iterate real devices instead of hard-coding serial numbers.
function devices() {
  if (!store) return [];
  return store.index.entries
    .filter((e) => e.endpoint === '/v4/new-api/queryLastData' && e.ok && e.request.deviceSn && !e.request.deviceSn.includes(','))
    .map((e) => ({ account: e.account, deviceSn: e.request.deviceSn, deviceType: e.request.deviceType }));
}

// A client wired to this account's captures, with no real credentials anywhere.
function client(account, extra) {
  // eslint-disable-next-line global-require
  const Api = require('../lib/growatt_api');
  return new Api({
    user_name: account, token: `fixture:${account}`, host: 'openapi.growatt.com', ...extra,
  });
}

const accounts = () => (store ? Object.keys(store.index.accounts || {}) : []);
// Which section of zzz_creds.txt an account came from: 'working', 'no-devices' or 'rejected'.
const accountsByTier = (tier) => (store
  ? Object.entries(store.index.tiers || {}).filter(([, v]) => v === tier).map(([k]) => k)
  : []);

module.exports = {
  available: !!store,
  count: store ? store.count : 0,
  index: store ? store.index : null,
  install,
  devices,
  client,
  accounts,
  accountsByTier,
  entries: () => (store ? store.index.entries : []),
  fixture: (account, endpoint, request) => (store ? store.table.get(`${account}|${endpoint}|${signature(request)}`) : null),
};

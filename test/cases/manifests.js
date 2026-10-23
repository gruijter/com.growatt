'use strict';

/* Checks `homey app validate` cannot make, on the built app.json (run `homey app build` first):
   1. what existing devices depend on is still there;
   2. every mapped capability exists, and the manifest names only capabilities a device can have;
   3. every translation has all 13 locales, every locales key used in code exists, every README. */

const fs = require('node:fs');
const path = require('node:path');
const homeyLib = require('homey-lib'); // eslint-disable-line node/no-unpublished-require
const growattMap = require('../../lib/growattMap');
const { deviceTitles } = require('../../lib/capabilityTitles');

const ROOT = path.join(__dirname, '..', '..');
const LOCALES = ['en', 'nl', 'de', 'fr', 'es', 'it', 'da', 'sv', 'no', 'pl', 'ru', 'ar', 'ko'];
const V2 = ['inverter2', 'battery2', 'meter2'];

// Remove an entry only together with the migration step that removes it from existing devices.
const PINNED = {
  appId: 'com.growatt',
  customCapabilities: ['charge_setpoint', 'measure_efficiency', 'measure_soh'],
  drivers: {
    inverter: ['username', 'password'],
    battery: ['username', 'password'],
    meter: ['username', 'password'],
    inverter2: ['username', 'token', 'host', 'deviceType', 'deviceSn', 'model', 'nominalPower', 'dailyEnergyHomeyTimezone'],
    battery2: ['username', 'token', 'host', 'deviceType', 'deviceSn', 'model', 'maxChargePower', 'maxDischargePower'],
    meter2: ['username', 'token', 'host', 'deviceType', 'deviceSn', 'model'],
  },
};

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

module.exports = async (t) => {
  const app = readJson('app.json');
  const drivers = Object.fromEntries(app.drivers.map((driver) => [driver.id, driver]));
  const system = homeyLib.getCapabilities();

  // --- 1. what existing devices depend on
  t.eq(app.id, PINNED.appId, 'app id');
  PINNED.customCapabilities.forEach((id) => t.ok(app.capabilities?.[id], `custom capability ${id} is still defined`));
  for (const [id, settings] of Object.entries(PINNED.drivers)) {
    const driver = drivers[id];
    t.ok(driver, `driver ${id} is still there`);
    if (!driver) continue;
    const ids = (driver.settings || []).flatMap((setting) => [setting, ...(setting.children || [])]).map((setting) => setting.id);
    const missing = settings.filter((setting) => !ids.includes(setting));
    t.ok(missing.length === 0, `${id}: settings still there${missing.length ? ` (gone: ${missing.join(', ')})` : ''}`);
  }

  // --- 2. capabilities
  for (const id of V2) {
    const driver = drivers[id];
    const possible = new Set(Object.values(growattMap[`${id}Map`])
      .flatMap((map) => Object.keys(map)));
    const unknown = [...possible].filter((cap) => !system[cap.split('.')[0]] && !app.capabilities?.[cap.split('.')[0]]);
    t.ok(unknown.length === 0, `${id}: every mapped capability exists${unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''}`);

    const named = [
      ...driver.capabilities.map((cap) => [cap, 'capabilities']),
      ...Object.keys(driver.capabilitiesOptions || {}).map((cap) => [cap, 'capabilitiesOptions']),
      ...Object.entries(driver.energy || {}).filter(([key]) => key.endsWith('Capability')).map(([key, cap]) => [cap, `energy.${key}`]),
    ];
    if (id === 'inverter2') {
      Object.keys(growattMap.inverter2Map).forEach((type) => [true, false, undefined].forEach((hasBattery) => {
        Object.keys(deviceTitles(type, hasBattery)).forEach((cap) => named.push([cap, `capabilityTitles ${type}`]));
      }));
    }
    const stray = [...new Set(named.filter(([cap]) => !possible.has(cap)).map(([cap, where]) => `${cap} (${where})`))];
    t.ok(stray.length === 0, `${id}: the manifest names only capabilities the device can have${stray.length ? ` (not mapped: ${stray.join(', ')})` : ''}`);
  }

  // --- 3. translations
  let translations = 0;
  const gaps = [];
  const walk = (node, trail) => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${trail}[${i}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    // strings per locale, or arrays per locale for the app's tags
    const kind = typeof node.en === 'string' ? 'string' : Array.isArray(node.en) && 'array';
    if (kind) {
      translations += 1;
      const missing = LOCALES.filter((locale) => (kind === 'array' ? !Array.isArray(node[locale]) : typeof node[locale] !== 'string'));
      if (missing.length) gaps.push(`${trail} (${missing.join(', ')})`);
    }
    Object.keys(node).forEach((key) => walk(node[key], `${trail}.${key}`));
  };
  walk(app, 'app.json');
  t.ok(gaps.length === 0, `${translations} translations carry all 13 locales${gaps.length ? `; missing: ${gaps.slice(0, 10).join('; ')}` : ''}`);

  const en = readJson('locales/en.json');
  const keyPattern = new RegExp(`^(?:${Object.keys(en).join('|')})\\.\\w+$`);
  const codeFiles = ['app.js',
    ...fs.readdirSync(path.join(ROOT, 'lib')).filter((file) => file.endsWith('.js')).map((file) => path.join('lib', file)),
    ...app.drivers.flatMap((driver) => ['driver.js', 'device.js'].map((file) => path.join('drivers', driver.id, file)))];
  const used = new Set(codeFiles
    .flatMap((file) => [...fs.readFileSync(path.join(ROOT, file), 'utf8').matchAll(/'([^'\n]+)'/g)].map((match) => match[1]))
    .filter((literal) => keyPattern.test(literal)));
  const lookup = (object, key) => key.split('.').reduce((node, part) => node?.[part], object);
  for (const locale of LOCALES) {
    const strings = readJson(`locales/${locale}.json`);
    const missing = [...used].filter((key) => typeof lookup(strings, key) !== 'string');
    t.ok(missing.length === 0, `locales/${locale}.json has the ${used.size} keys used in code${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
    const readme = locale === 'en' ? 'README.txt' : `README.${locale}.txt`;
    t.ok(fs.existsSync(path.join(ROOT, readme)), `${readme} exists`);
  }
};

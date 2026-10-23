'use strict';

/* lib/DeviceMigrator.js against a fake device that behaves like Homey's: capabilities keep the
   order they were added in, values and options vanish with a removed capability, and
   getCapabilityOptions() throws for a capability that has none. */

const DeviceMigrator = require('../../lib/DeviceMigrator');
const growattMap = require('../../lib/growattMap');

const fakeDevice = ({ caps, values = {}, manifestOptions = {} }) => {
  const state = {
    caps: [...caps], values: { ...values }, options: {}, available: true, touched: [], writes: 0,
  };
  return {
    state,
    homey: { __: (key) => key, setTimeout: (fn) => fn(), app: { manifest: {} } },
    driver: { manifest: { capabilitiesOptions: manifestOptions } },
    log: () => {},
    error: (...args) => {
      throw Error(args.join(' '));
    },
    getName: () => 'fake',
    getAvailable: () => state.available,
    setAvailable: async () => {
      state.available = true;
    },
    setUnavailable: async () => {
      state.available = false;
    },
    getCapabilities: () => [...state.caps],
    hasCapability: (cap) => state.caps.includes(cap),
    getCapabilityValue: (cap) => (cap in state.values ? state.values[cap] : null),
    setCapabilityValue: async (cap, value) => {
      state.values[cap] = value;
    },
    addCapability: async (cap) => {
      state.touched.push(`+${cap}`);
      state.caps.push(cap);
    },
    removeCapability: async (cap) => {
      state.touched.push(`-${cap}`);
      state.caps = state.caps.filter((c) => c !== cap);
      delete state.values[cap];
      delete state.options[cap];
    },
    getCapabilityOptions: (cap) => {
      if (!state.options[cap]) throw Error(`Invalid Capability: ${cap}`);
      return state.options[cap];
    },
    setCapabilityOptions: async (cap, options) => {
      state.writes += 1;
      state.options[cap] = options;
    },
  };
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

module.exports = async (t) => {
  // an inverter2 string inverter that turns out to be a hybrid, and back
  const string = Object.keys(growattMap.inverterCapabilities('min', false));
  const hybrid = Object.keys(growattMap.inverterCapabilities('min', true));
  t.ok(!same(string, hybrid), 'min string and hybrid capability sets differ');
  for (const [from, to, label] of [[string, hybrid, 'string -> hybrid'], [hybrid, string, 'hybrid -> string']]) {
    const values = Object.fromEntries(from.map((cap, i) => [cap, i + 1]));
    const device = fakeDevice({ caps: from, values });
    // eslint-disable-next-line no-await-in-loop
    t.ok(await DeviceMigrator.migrateCapabilities(device, to, { settleMs: 0 }), `${label}: migrated`);
    t.ok(same(device.state.caps, to), `${label}: list and order as wanted`);
    t.ok(to.every((cap) => !(cap in values) || device.state.values[cap] === values[cap]), `${label}: kept values restored`);
    t.ok(device.state.available, `${label}: available again afterwards`);
    // eslint-disable-next-line no-await-in-loop
    t.ok(!(await DeviceMigrator.migrateCapabilities(device, to, { settleMs: 0 })), `${label}: second run changes nothing`);
  }

  // alarm_generic replaced by alarm_problem + alarm_connectivity: only the tail changes
  for (const [driverId, type] of [['inverter2', 'min'], ['meter2', 'min'], ['battery2', 'noah']]) {
    const map = driverId === 'inverter2' ? growattMap.inverterCapabilities(type, true) : growattMap[`${driverId}Map`][type];
    const to = Object.keys(map);
    const from = [...to.filter((cap) => !cap.startsWith('alarm_')), ...(driverId === 'inverter2' ? ['alarm_generic'] : [])];
    const values = Object.fromEntries(from.map((cap, i) => [cap, i + 1]));
    const old = fakeDevice({ caps: from, values });
    // eslint-disable-next-line no-await-in-loop
    await DeviceMigrator.migrateCapabilities(old, to, { settleMs: 0 });
    t.ok(same(old.state.caps, to), `${driverId}/${type}: the new alarms last, in order`);
    const touched = old.state.touched.map((x) => x.slice(1));
    t.ok(touched.every((cap) => cap.startsWith('alarm_')), `${driverId}/${type}: no other tile rebuilt (${old.state.touched.join(' ')})`);
  }

  // target_power options: written once, then left alone; re-applied after a rebuild
  const settings = { deviceType: 'min', nominalPower: 3300 };
  const wanted = { target_power: growattMap.targetPowerOptions('inverter2', settings) };
  const device = fakeDevice({ caps: ['measure_power', 'target_power'], manifestOptions: { target_power: { decimals: 0 } } });
  await DeviceMigrator.syncCapabilityOptions(device, wanted);
  t.eq(device.state.writes, 1, 'target_power options written when the device has none of its own');
  t.ok(same(device.state.options.target_power, { decimals: 0, ...wanted.target_power }), 'merged onto the manifest options');
  await DeviceMigrator.syncCapabilityOptions(device, wanted);
  t.eq(device.state.writes, 1, 'unchanged target_power options are not rewritten');
  await DeviceMigrator.syncCapabilityOptions(device, { missing_cap: { title: { en: 'x' } } });
  t.eq(device.state.writes, 1, 'options for a capability the device lacks are skipped');
};

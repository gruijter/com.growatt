'use strict';

/* lib/growattErrors.js, and the one write path that capability and flow writes share. */

const requireStubbed = require('../stubs');
const growattErrors = require('../../lib/growattErrors');

const loadDevice = () => requireStubbed(require.resolve('../../lib/common_device.js'), { homey: { Device: class {} } });

const apiError = (reason, errorCode) => Object.assign(Error(`localized ${reason}`), { reason, errorCode });

module.exports = async (t) => {
  t.ok(growattErrors.backsOffPolling(apiError('DEVICE_OFFLINE', 1)), 'an offline device holds off its reads');
  t.ok(growattErrors.backsOffPolling(apiError('RATE_LIMITED')), 'a rate limit holds off its reads');
  t.ok(!growattErrors.backsOffPolling(apiError('PERMISSION_DENIED', 1)), 'a refused token does not');

  ['RATE_LIMITED', 'HTTP_ERROR', 'TIMEOUT', 'NETWORK'].forEach((reason) => {
    t.ok(growattErrors.isTransient(reason), `${reason} leaves the device available`);
  });
  t.ok(!growattErrors.isTransient('PERMISSION_DENIED'), 'PERMISSION_DENIED is not transient');
  t.ok(!growattErrors.isTransient(undefined), 'an error without a reason is not transient');

  t.eq(growattErrors.writeErrorKey(apiError('x', 6)), 'errors.commandRejected', 'code 6: rejected');
  t.eq(growattErrors.writeErrorKey(apiError('WRONG_PARAMETER_VALUE', 1)), 'errors.commandRejected', 'a wrong value: rejected');
  t.eq(growattErrors.writeErrorKey(apiError('x', 16)), 'errors.commandRejectedOrOffline', 'code 16: not responding');
  t.eq(growattErrors.writeErrorKey(apiError('PARAMETER_SETTING_RESPONSE_TIMEOUT', 1)), 'errors.commandRejectedOrOffline', 'a response timeout: not responding');
  t.eq(growattErrors.writeErrorKey(apiError('PERMISSION_DENIED', 1)), null, 'other errors keep their own message');
  t.ok(growattErrors.isNotResponding(Error('PARAMETER_SETTING_DEVICE_NOT_RESPONDING')), 'matched in a plain message too');

  // the client turns a fetch failure into a reason code with a localized message
  const Api = require('../../lib/growatt_api');
  const realFetch = globalThis.fetch;
  try {
    const failWith = async (error) => {
      globalThis.fetch = async () => {
        throw error;
      };
      const api = new Api({ user_name: `u${Math.random()}`, token: 't', host: 'h' });
      return api.getLastData({ deviceSn: 'SN', deviceType: 'min' }).catch((e) => e);
    };
    const abort = Object.assign(Error('This operation was aborted'), { name: 'AbortError' });
    const timedOut = await failWith(abort);
    t.eq(timedOut.reason, 'TIMEOUT', 'an aborted request: TIMEOUT');
    t.eq(timedOut.message, 'The Growatt server did not answer in time.', 'with the timeout text');
    const unreachable = await failWith(new TypeError('fetch failed'));
    t.eq(unreachable.reason, 'NETWORK', 'an unreachable host: NETWORK');
    const dropped = await failWith(new TypeError('terminated'));
    t.eq(dropped.reason, 'NETWORK', 'a connection dropped during the body: NETWORK');
    const odd = await failWith(Error('something else'));
    t.eq(odd.message, 'something else', 'any other failure passes through');
  } finally {
    globalThis.fetch = realFetch;
  }

  const Device = loadDevice();
  const device = (answers) => {
    const dev = Object.create(Device.prototype);
    const calls = [];
    Object.assign(dev, {
      calls,
      deviceSn: 'SN',
      deviceType: 'min',
      backoffUntil: 123,
      homey: { __: (key, tokens) => (tokens ? `${key}:${JSON.stringify(tokens)}` : key) },
      driver: { id: 'inverter2' },
      log: () => {},
      error: () => {},
      getSettings: () => ({}),
      delay: async () => {},
      growatt: {
        setActivePower: async (args) => {
          calls.push(args);
          const answer = answers.shift();
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
    });
    return dev;
  };
  const mapFunc = (val) => ({ call: 'setActivePower', value: String(val) });

  const once = device([apiError('x', 16), {}]);
  t.eq(await once.writeSetting('target_power', 500, mapFunc), true, 'not responding, then accepted: written');
  t.eq(once.calls.length, 2, 'retried once');
  t.eq(once.backoffUntil, 0, 'a successful write lifts the read backoff');

  const twice = device([apiError('x', 16), apiError('x', 16)]);
  const offline = await twice.writeSetting('target_power', 500, mapFunc).catch((error) => error.message);
  t.eq(offline, 'errors.commandRejectedOrOffline', 'not responding twice: rejected or offline');
  t.eq(twice.calls.length, 2, 'and no third try');

  const rejected = device([apiError('PARAMETER_SETTING_FAILED', 6)]);
  t.eq(await rejected.writeSetting('target_power', 500, mapFunc).catch((error) => error.message), 'errors.commandRejected', 'rejected: no retry');
  t.eq(rejected.calls.length, 1, 'a rejection is not retried');

  const other = device([apiError('PERMISSION_DENIED', 1)]);
  t.eq(await other.writeSetting('target_power', 500, mapFunc).catch((error) => error.message), 'localized PERMISSION_DENIED', 'other errors keep their message');

  // a lasting outage: every poll fails, so no lastData ever arrives to run the watchdog
  const EventEmitter = require('node:events');
  const homey = Object.assign(new EventEmitter(), { __: (key) => key });
  const quiet = Object.assign(Object.create(Device.prototype), {
    homey,
    deviceSn: 'SN',
    deviceType: 'min',
    lastPoll: Date.now() - (30 * 60 * 1000),
    unavailable: null,
    log: () => {},
    error: () => {},
    getName: () => 'test',
    getSettings: () => ({}),
    getCapabilities: () => [],
    setUnavailable: async (message) => {
      quiet.unavailable = message;
    },
  });
  quiet.startListeners();
  homey.emit('errorInfo', { device: { deviceSn: 'SN' }, error: 'timeout', reason: 'TIMEOUT' });
  t.eq(quiet.unavailable, null, 'a timeout leaves the device available');
  quiet.lastPoll = Date.now() - (62 * 60 * 1000);
  homey.emit('errorInfo', { device: { deviceSn: 'SN' }, error: 'timeout', reason: 'TIMEOUT' });
  t.eq(quiet.unavailable, 'status.noUpdates', 'an hour of failed polls makes it unavailable');
  quiet.destroyListeners();

  const flow = device([]);
  const unsupported = await flow.handleFlowAction({ action: 'nope', val: 1 }).catch((error) => error.message);
  t.eq(unsupported, 'errors.actionNotSupported:{"action":"nope"}', 'a flow action without a mapping is refused');
};

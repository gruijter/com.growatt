'use strict';

/* lib/growattCapture.js round trip: once per request per arm, redacted, and identical to what the
   real client returned. */

const capture = require('../../lib/growattCapture');
const fixtures = require('../fixtures');

module.exports = async (t) => {
  const lines = [];
  capture.setLog((line) => lines.push(`2026-10-20T10:00:00.000Z [log] [ManagerDrivers] ${line}`));
  try {
    capture.arm('test', { force: true });
    const big = { min: [{ serialNum: 'SN1', pac: 1234.5, text: 'x'.repeat(2000) }] };
    t.ok(capture.record('/v4/new-api/queryLastData', { deviceSn: 'SN1', deviceType: 'min', user_name: 'secret' }, { response: big }), 'a read is captured');
    t.ok(!capture.record('/v4/new-api/queryLastData', { deviceSn: 'SN1', deviceType: 'min' }, { response: big }), 'the same request is captured once per arm');
    t.ok(!capture.record('/v4/new-api/setPower', { deviceSn: 'SN1' }, { response: {} }), 'a write is never captured');
    capture.record('/v1/plant/details', { plant_id: 7 }, {
      response: {
        name: 'Home', latitude: '52.1', longitude_d: '5', address1: 'Street 1', ownercontact: 'me', peak_power: 5,
      },
    });
    capture.record('/v4/new-api/readPower', { deviceSn: 'SN1', deviceType: 'min' }, { error: { reason: 'PERMISSION_DENIED', errorCode: 10011, message: 'x' } });

    const report = lines.join('\n');
    t.ok(!report.includes('secret'), 'credentials stay out of the log');
    const { captures, errors } = capture.parseLog(report);
    t.eq(errors.length, 0, 'the report parses without errors');
    t.eq(captures.length, 3, 'three captures read back');
    t.ok(JSON.stringify(captures[0].response) === JSON.stringify(big), 'a multi-chunk response comes back intact');
    t.ok(JSON.stringify(captures[0].request) === JSON.stringify({ deviceSn: 'SN1', deviceType: 'min' }), 'only the selecting parameters are kept');
    const details = captures[1].response;
    t.ok(details.name === 'Home' && details.peak_power === 5, 'plant name and data are kept');
    t.ok(['latitude', 'longitude_d', 'address1', 'ownercontact'].every((k) => details[k] === '<redacted>'), 'location and contact details are redacted');
    t.eq(captures[2].error.reason, 'PERMISSION_DENIED', 'a server error is captured with its reason');
    t.eq(capture.parseLog(report.split('\n').filter((l) => !l.includes('c1|2|')).join('\n')).errors.length, 1, 'a missing chunk is reported');

    // the real client on replayed fixtures: what it logs equals what it was served
    if (!fixtures.available) return t.skip('no zzz_responses/ - run `node zzz_collect.js` to capture');
    const net = fixtures.install();
    try {
      const dev = fixtures.devices()[0];
      lines.length = 0;
      capture.arm('replay', { force: true });
      const g = fixtures.client(dev.account);
      const served = await g.getLastData({ deviceSn: dev.deviceSn, deviceType: dev.deviceType });
      const [captured] = capture.parseLog(lines.join('\n')).captures;
      t.ok(captured && JSON.stringify(captured.response) === JSON.stringify(served), `${dev.deviceSn}: the client logs exactly the lastData it returned`);
    } finally {
      net.restore();
    }
  } finally {
    capture.setLog(null);
  }
  return undefined;
};

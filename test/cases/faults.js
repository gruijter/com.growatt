'use strict';

/* inverter2's alarm_generic from the documented lastData `status` per device type. No captured
   payload was ever in a fault state, so these are synthetic. */

const growattMap = require('../../lib/growattMap');

const FAULT = {
  inv: 3, storage: 3, max: 3, wit: 3, 'sph-s': 3, min: 2, sph: 2, noah: 4,
};

module.exports = async (t) => {
  for (const [type, fault] of Object.entries(FAULT)) {
    const map = growattMap.inverter2Map[type].alarm_generic[1];
    t.eq(map({ status: fault }), true, `${type}: status ${fault} is a fault`);
    t.eq(map({ status: String(fault) }), true, `${type}: status "${fault}" (string) is a fault`);
    t.eq(map({ status: 1 }), false, `${type}: status 1 is no fault`);
    t.eq(map({}), undefined, `${type}: no status leaves the alarm untouched`);
  }
  const noah = growattMap.inverter2Map.noah.alarm_generic[1];
  t.eq(noah({ status: 1, faultStatus: 2 }), true, 'noah: a battery pack fault bit is a fault');
  t.eq(noah({ status: 1, faultStatus: 0 }), false, 'noah: no fault bits, no fault');
  t.ok(!growattMap.inverter2Map.spa.alarm_generic, 'spa: no documented status values, no alarm');
};

'use strict';

/* growattMap.calcSolarAC: without pac, or with an unreadable battery power, the tile keeps its value. */

const { calcSolarAC } = require('../../lib/growattMap');

module.exports = async (t) => {
  t.eq(calcSolarAC(1000, 500, 0, 96, 2000), 1480, 'pac plus the battery charge');
  t.eq(calcSolarAC(undefined, 500, 0, 96, 2000), undefined, 'no value without pac');
  t.eq(calcSolarAC(1000, 'x', 0, 96, 2000), undefined, 'no value with an unreadable charge power');
  t.eq(calcSolarAC(1000, undefined, undefined, 96), 1000, 'no battery fields: pac');
};

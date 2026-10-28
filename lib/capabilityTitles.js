/*
Copyright 2025 - 2026, Robin de Gruijter (rmdegruijter@gmail.com)

This file is part of com.growatt.

com.growatt is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.growatt is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.growatt.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

// inverter2 titles that differ per device type, stamped per device since one compose block serves
// nine types. The solar titles come from the shared solarTitles.js.

const { solarTitle } = require('./solarTitles');

// The side each type reports solar yield on; keep in step with inverterMap in growattMap.js.
// noah is 'dc': its eac* counters follow the panels.
const YIELD_SIDE = {
  inv: 'ac',
  max: 'ac',
  noah: 'dc',
  storage: 'dc',
  sph: 'dc',
  spa: 'dc',
  min: 'dc',
  wit: 'dc',
  'sph-s': 'dc',
};

// noah is a DC-DC converter: measure_power is the panels and measure_efficiency the converter's.
const NOAH_TITLES = {
  measure_power: solarTitle('measure_power', 'dc'),
  measure_efficiency: {
    en: 'Converter efficiency',
    nl: 'Converterrendement',
    da: 'Konvertervirkningsgrad',
    de: 'Wandler-Wirkungsgrad',
    es: 'Rendimiento convertidor',
    fr: 'Rendement convertisseur',
    it: 'Rendimento convertitore',
    no: 'Omformervirkningsgrad',
    sv: 'Omvandlarverkningsgrad',
    pl: 'Sprawność przetwornicy',
    ru: 'КПД преобразователя',
    ko: '컨버터 효율',
    ar: 'كفاءة المحول',
  },
};

// { capabilityId: title } for a device type ({} when not covered). hasBattery false (never
// charged) switches a hybrid to AC titles; undefined keeps DC.
const deviceTitles = (deviceType, hasBattery) => {
  let side = YIELD_SIDE[deviceType];
  if (!side) return {};
  if (side === 'dc' && hasBattery === false) side = 'ac';
  return {
    meter_power: solarTitle('meter_power', side),
    'meter_power.today': solarTitle('meter_power.today', side),
    ...(deviceType === 'noah' ? NOAH_TITLES : {}),
  };
};

module.exports = { deviceTitles };

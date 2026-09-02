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

// `inverter2` serves nine device types with one set of capabilitiesOptions, but meter_power and
// meter_power.today do not mean the same thing on all of them: string inverters report solar yield
// on the AC side, hybrids on the DC side (see the note above the yield helpers in growattMap.js).
// A single compose-declared title cannot say both, so the driver stamps the right one per device
// at runtime via setCapabilityOptions() - the same approach com.gruijter.powerhour uses in
// drivers/grid/device.js#updatePeakLoadCapabilityTitles(), including its rule to merge onto the
// MANIFEST options rather than the device's current ones, so repeated calls cannot compound.
//
// Titles are built from a base phrase plus a side marker instead of being written out four times,
// so the AC and DC variants can never drift apart. Spanish, French and Italian mark the sides as
// CA/CC rather than AC/DC, matching the existing measure_power.* titles in the compose file.

const LOCALES = ['en', 'nl', 'da', 'de', 'es', 'fr', 'it', 'no', 'sv', 'pl', 'ru', 'ko', 'ar'];

const SIDE_MARKER = {
  ac: {
    es: 'CA', fr: 'CA', it: 'CA', default: 'AC',
  },
  dc: {
    es: 'CC', fr: 'CC', it: 'CC', default: 'DC',
  },
};

const BASE = {
  total: {
    en: 'Solar energy',
    nl: 'Zonopbrengst',
    da: 'Solproduktion',
    de: 'Solarertrag',
    es: 'Producción solar',
    fr: 'Production solaire',
    it: 'Produzione solare',
    no: 'Solproduksjon',
    sv: 'Solproduktion',
    pl: 'Uzysk słoneczny',
    ru: 'Выработка солнечной энергии',
    ko: '태양광 발전량',
    ar: 'إنتاج الطاقة الشمسية',
  },
  today: {
    en: 'Solar energy today',
    nl: 'Zonopbrengst vandaag',
    da: 'Solproduktion i dag',
    de: 'Solarertrag heute',
    es: 'Producción solar de hoy',
    fr: "Production solaire aujourd'hui",
    it: 'Produzione solare di oggi',
    no: 'Solproduksjon i dag',
    sv: 'Solproduktion idag',
    pl: 'Uzysk słoneczny dzisiaj',
    ru: 'Выработка солнечной энергии сегодня',
    ko: '오늘 태양광 발전량',
    ar: 'إنتاج الطاقة الشمسية اليوم',
  },
};

// Which side each device type reports its solar yield on. Must stay in step with inverterMap in
// growattMap.js: the types using acYieldTotal/acYieldToday are 'ac', the ones using
// dcYieldTotal/dcYieldToday or noahPvYieldTotal/noahPvYieldToday are 'dc'.
//
// 'noah' is 'dc' despite reading eacToday/eacTotal: a NOAH has no AC side whatsoever (its only
// output is a DC port feeding a separate micro-inverter) and those counters were measured to track
// the panels, not the output - see the note above noahPvYieldTotal in growattMap.js.
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

const buildTitle = (which, side) => {
  const markers = SIDE_MARKER[side];
  const title = {};
  LOCALES.forEach((locale) => {
    title[locale] = `${BASE[which][locale]} (${markers[locale] || markers.default})`;
  });
  return title;
};

// Returns { <capabilityId>: <13-locale title object> } for the given deviceType, or an empty
// object for a type this map does not cover (so a caller can just iterate the result).
//
// hasBattery mirrors growattMap.js#hasBatteryHistory: explicitly false for a hybrid that has never
// charged or discharged, true when it has, undefined when the payload gives no way to tell. Such a
// hybrid reports its yield on the AC side (see solarYieldTotal there), so the title has to follow -
// only an explicit false flips it, leaving undefined on the safe DC default.
const solarYieldTitles = (deviceType, hasBattery) => {
  let side = YIELD_SIDE[deviceType];
  if (!side) return {};
  if (side === 'dc' && hasBattery === false) side = 'ac';
  return {
    meter_power: buildTitle('total', side),
    'meter_power.today': buildTitle('today', side),
  };
};

module.exports = { solarYieldTitles, LOCALES };

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
// nine types. Built from a base phrase plus a side marker (CA/CC in es, fr, it).

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
    ru: 'Солнечная энергия',
    ko: '태양광 발전량',
    ar: 'الطاقة الشمسية',
  },
  today: {
    en: 'Solar energy today',
    nl: 'Opbrengst vandaag',
    da: 'Produktion i dag',
    de: 'Solarertrag heute',
    es: 'Producción de hoy',
    fr: 'Production du jour',
    it: 'Produzione di oggi',
    no: 'Produksjon i dag',
    sv: 'Solproduktion idag',
    pl: 'Uzysk dzisiaj',
    ru: 'Энергия сегодня',
    ko: '오늘 태양광 발전량',
    ar: 'الطاقة اليوم',
  },
};

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

const buildTitle = (which, side) => {
  const markers = SIDE_MARKER[side];
  const title = {};
  LOCALES.forEach((locale) => {
    title[locale] = `${BASE[which][locale]} (${markers[locale] || markers.default})`;
  });
  return title;
};

// noah is a DC-DC converter: measure_power is the panels and measure_efficiency the converter's.
const NOAH_TITLES = {
  measure_power: {
    en: 'Solar power (DC)',
    nl: 'Zonnevermogen (DC)',
    da: 'Soleffekt (DC)',
    de: 'Solarleistung (DC)',
    es: 'Potencia solar (CC)',
    fr: 'Puissance solaire (CC)',
    it: 'Potenza solare (CC)',
    no: 'Soleffekt (DC)',
    sv: 'Soleffekt (DC)',
    pl: 'Moc słoneczna (DC)',
    ru: 'Солнечная мощность (DC)',
    ko: '태양광 전력(DC)',
    ar: 'القدرة الشمسية (DC)',
  },
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
    meter_power: buildTitle('total', side),
    'meter_power.today': buildTitle('today', side),
    ...(deviceType === 'noah' ? NOAH_TITLES : {}),
  };
};

module.exports = { deviceTitles, LOCALES };

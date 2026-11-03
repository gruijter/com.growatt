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

// Titles of the inverter's solar capabilities: what the capability is - solar power, solar energy -
// plus the side it is measured on. AC is the aim; DC only where the inverter gives nothing else.
// Built from a base phrase plus a side marker, so the AC and DC variants cannot drift apart.
// Spanish, French and Italian write CA/CC. One file, kept identical (apart from the licence header)
// in com.growatt, com.foxess (cloud and Modbus inverters), com.solarwatt, com.sungrowpower and
// com.tigoenergy.

const SIDE_MARKER = {
  ac: {
    es: 'CA', fr: 'CA', it: 'CA', default: 'AC',
  },
  dc: {
    es: 'CC', fr: 'CC', it: 'CC', default: 'DC',
  },
};

const BASE = {
  measure_power: {
    en: 'Solar power',
    nl: 'Zonnevermogen',
    da: 'Soleffekt',
    de: 'Solarleistung',
    es: 'Potencia solar',
    fr: 'Puissance solaire',
    it: 'Potenza solare',
    no: 'Soleffekt',
    sv: 'Soleffekt',
    pl: 'Moc słoneczna',
    ru: 'Солнечная мощность',
    ko: '태양광 전력',
    ar: 'القدرة الشمسية',
  },
  meter_power: {
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
  'meter_power.today': {
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
  'meter_power.month': {
    en: 'Solar energy this month',
    nl: 'Opbrengst deze maand',
    da: 'Produktion denne måned',
    de: 'Solarertrag diesen Monat',
    es: 'Producción de este mes',
    fr: 'Production du mois',
    it: 'Produzione di questo mese',
    no: 'Produksjon denne måneden',
    sv: 'Solproduktion denna månad',
    pl: 'Uzysk w tym miesiącu',
    ru: 'Энергия за этот месяц',
    ko: '이번 달 태양광 발전량',
    ar: 'الطاقة هذا الشهر',
  },
};

/**
 * The title of a solar capability for a side.
 * @param {string} cap measure_power, meter_power, meter_power.today or meter_power.month
 * @param {'ac'|'dc'} side
 * @returns {Object<string, string>} locale -> title
 */
const solarTitle = (cap, side) => Object.fromEntries(Object.entries(BASE[cap]).map(([locale, text]) => {
  const marker = SIDE_MARKER[side][locale] || SIDE_MARKER[side].default;
  return [locale, `${text} (${marker})`];
}));

const SOLAR_CAPABILITIES = Object.keys(BASE);

module.exports = { solarTitle, SOLAR_CAPABILITIES };

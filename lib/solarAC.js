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

/*
 * Solar power on the AC side of a DC-coupled hybrid inverter. One file, kept identical (apart from
 * the licence header) in com.growatt, com.foxess, com.solarwatt and com.sungrowpower. The live
 * efficiency stays in each app: its floor, units and rounding differ per brand.
 */

/** Efficiency for the battery term when the live figure is unusable; the top of what these hybrids reach. */
const FALLBACK_EFFICIENCY_PCT = 98;

/**
 * With n the DC -> AC efficiency:
 *
 *   solarAC = pv * n = (dcIn + battery) * n = ac + battery * n
 *
 * Computed as `ac + battery * n` so a fallback n only affects the battery term, and capped at
 * `pv * n` so a grid charge is not booked as solar (a 2 kW grid charge at night showed ~1960 W).
 * The cap is exactly inert while the battery charges from the panels, which needs the live
 * efficiency at full precision. Any unit; unrounded.
 * @param {object} p
 * @param {number} p.ac AC output, battery included
 * @param {number} [p.battery] net battery DC power, positive while charging
 * @param {number} [p.pv] DC power of the strings; no cap without it
 * @param {number} [p.efficiencyPct] live efficiency; outside 50-100 the fallback is used
 * @returns {number|undefined} undefined without an AC reading
 */
const solarAC = ({
  ac, battery, pv, efficiencyPct,
}) => {
  if (!Number.isFinite(ac)) return undefined;
  const usable = Number.isFinite(efficiencyPct) && efficiencyPct >= 50 && efficiencyPct <= 100;
  const eff = (usable ? efficiencyPct : FALLBACK_EFFICIENCY_PCT) / 100;
  const solar = Math.max(0, ac + (Number.isFinite(battery) ? battery : 0) * eff);
  return Number.isFinite(pv) ? Math.min(solar, Math.max(0, pv * eff)) : solar;
};

module.exports = { solarAC };

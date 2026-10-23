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
What a failed API call means, from what lib/growatt_api.js puts on the error: `reason` (a stable
code, or the raw API message when unmapped; the message itself is localized) and `errorCode` (the
API's own code).
*/

// a read the device cannot answer now: that poll waits 5 minutes
const POLL_BACKOFF = new Set(['zfdyh_Read_failure', 'READ_DEVICE_PARAM_FAIL', 'DEVICE_OFFLINE', 'RATE_LIMITED']);
// cleared by the next poll, so the device stays available; the watchdog handles real outages
const TRANSIENT = new Set(['RATE_LIMITED', 'HTTP_ERROR', 'TIMEOUT', 'NETWORK']);
const NOT_RESPONDING = ['PARAMETER_SETTING_DEVICE_NOT_RESPONDING', 'PARAMETER_SETTING_RESPONSE_TIMEOUT'];
const REJECTED = ['PARAMETER_SETTING_FAILED', 'WRONG_PARAMETER_VALUE'];

const reasonOf = (error) => error?.reason || error?.message || String(error);
const mentions = (error, codes) => {
  const text = `${error?.reason ?? ''} ${error?.message ?? error}`;
  return codes.some((code) => text.includes(code));
};

/** Whether a failed read should hold off further reads of the device for a while. */
const backsOffPolling = (error) => POLL_BACKOFF.has(reasonOf(error));

/** Whether a failed poll leaves the device available. */
const isTransient = (reason) => TRANSIENT.has(reason);

/** Whether a write failed because the device did not answer in time: worth one retry. */
const isNotResponding = (error) => [15, 16].includes(error?.errorCode) || mentions(error, NOT_RESPONDING);

/**
 * The locales key for a refused write, else null (the error's own message applies).
 * @param {Error} error from a set call
 * @returns {string|null}
 */
const writeErrorKey = (error) => {
  if (isNotResponding(error)) return 'errors.commandRejectedOrOffline';
  if ([6, 14].includes(error?.errorCode) || mentions(error, REJECTED)) return 'errors.commandRejected';
  return null;
};

module.exports = {
  backsOffPolling, isNotResponding, isTransient, writeErrorKey,
};

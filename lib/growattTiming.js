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
Cloud data does not arrive on the wall clock. The datalogger uploads on its own free-running
timer - measured at ~361 s on three separate sites, drifting steadily against real time - while
Growatt refuses a repeat of the same queryLastData inside the window its docs give for that
device type (5 minutes; 1 minute for noah). Polling every device on its own clock, phase-locked
to the upload timestamp the payload itself carries, picks new data up ~POLL_MARGIN after it
appears instead of up to a full cadence later. See zzz_docs/API-FIELD-NOTES.md sections 10-11.
*/

const POLL_PROFILE = {
  default: { cadence: 361000, minInterval: 305000, bounds: [305000, 420000] },
  noah: { cadence: 61000, minInterval: 61000, bounds: [55000, 130000] },
};
const POLL_MARGIN = 30000; // how long after an expected upload to poll, allowing for jitter
const POLL_STAGGER = 2000; // spread the first poll of each device so no queue forms at boot
const PHASE_STEP = 45000; // how far to nudge the aim when the payload says we mistimed a poll
// The same upload this long after it was first seen (Homey's clock, not the payload's skewed one):
// the datalogger is silent (night), not late.
const SILENT_AFTER_CADENCES = 2;

const pollProfile = (deviceType) => POLL_PROFILE[deviceType] || POLL_PROFILE.default;

const newSchedule = (device) => ({
  label: `${device.deviceSn} (${device.deviceType})`,
  timeoutId: null,
  cadence: pollProfile(device.deviceType).cadence,
  lastUploadAt: 0,
  uploadSeenAt: 0,
  lastPollAt: 0,
  skew: 0,
  phase: 0,
  earlyNudge: 0, // phase added by "too early" polls since the last new upload
});

/**
 * Offset of the upload clock from real time. `calendar` is the plant's wall clock parsed in the
 * server's timezone (measured -6 h for a CEST plant), so derive it from a freshly changed upload,
 * rounded to whole quarter-hours like every timezone offset.
 */
const clockSkew = (uploadAt, cadence, nowMs = Date.now()) => Math.round(((uploadAt - nowMs) + (cadence / 2)) / 900000) * 900000;

/**
 * Learn from the upload time a poll returned (0: none) and return when to poll next.
 * @param {object} schedule from newSchedule(), with lastPollAt set; updated in place
 * @param {number} uploadAt the upload time on the payload's clock (epoch ms), 0 when unknown
 * @param {string} deviceType
 * @param {number} [nowMs]
 * @returns {number} epoch ms of the next poll on Homey's clock
 */
const nextPollAt = (schedule, uploadAt, deviceType, nowMs = Date.now()) => {
  const { minInterval, bounds } = pollProfile(deviceType);
  if (uploadAt > schedule.lastUploadAt) {
    // cadence from consecutive uploads, smoothed; a gap of two periods counts as a missed upload
    if (schedule.lastUploadAt) {
      const gap = uploadAt - schedule.lastUploadAt;
      const periods = Math.max(1, Math.round(gap / schedule.cadence));
      const observed = gap / periods;
      if (observed >= bounds[0] && observed <= bounds[1]) {
        schedule.cadence = Math.round((schedule.cadence * 0.7) + (observed * 0.3));
      }
      // skipped the upload we aimed at: aimed too late (deliberate k-th-upload skips excluded)
      if (periods > 1 && schedule.aimedPeriods === 1) {
        schedule.phase = Math.max(-schedule.cadence, schedule.phase - PHASE_STEP);
      }
    }
    schedule.lastUploadAt = uploadAt;
    schedule.uploadSeenAt = nowMs;
    schedule.earlyNudge = 0;
    // only on a changed timestamp: stale data would skew it without bound
    schedule.skew = clockSkew(uploadAt, schedule.cadence, nowMs);
  } else if (uploadAt && nowMs - schedule.uploadSeenAt < SILENT_AFTER_CADENCES * schedule.cadence) {
    // the same upload twice while the next was due: aimed too early
    const phase = Math.min(schedule.cadence, schedule.phase + PHASE_STEP);
    schedule.earlyNudge = (schedule.earlyNudge || 0) + (phase - schedule.phase);
    schedule.phase = phase;
  } else if (uploadAt && schedule.earlyNudge) {
    // that "early" poll was the start of a silence: take its nudge back
    schedule.phase -= schedule.earlyNudge;
    schedule.earlyNudge = 0;
  }

  // Aim POLL_MARGIN after the first upload due once this request's window has closed (a repeat
  // inside it is refused); that may skip one upload but locks the phase in one cycle.
  const earliest = schedule.lastPollAt + minInterval;
  if (!schedule.lastUploadAt) return earliest;
  const base = (schedule.lastUploadAt - schedule.skew) + POLL_MARGIN + schedule.phase;
  const periods = Math.max(1, Math.ceil((earliest - base) / schedule.cadence));
  schedule.aimedPeriods = periods; // so a deliberate skip is not later read as a mistimed poll
  return Math.max(base + (periods * schedule.cadence), earliest);
};

module.exports = {
  POLL_STAGGER, clockSkew, newSchedule, nextPollAt, pollProfile,
};

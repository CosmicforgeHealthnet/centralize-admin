"use strict";

// Time-zone aware scheduling without external dependencies (Intl only).
// Local wall-clock times are converted to UTC with explicit DST handling:
// - a non-existent local time (spring-forward gap) is rejected, never shifted
//   silently;
// - an ambiguous local time (fall-back overlap) resolves to the FIRST
//   occurrence (the earlier instant), and the response says so.

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function wallClock(instantMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(instantMs));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

// Offset (ms) of the zone at the given instant: local - UTC.
function zoneOffsetMs(instantMs, timeZone) {
  const w = wallClock(instantMs, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

function formatLocal(w) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/**
 * Convert "YYYY-MM-DDTHH:mm" in timeZone to a UTC Date.
 * Returns { utc, ambiguous } or throws { code: SCHEDULE_TIME_INVALID | SCHEDULE_TIME_NONEXISTENT }.
 */
function zonedLocalToUtc(local, timeZone) {
  const match = LOCAL.exec(String(local || ""));
  if (!match || !isValidTimeZone(timeZone)) throw Object.assign(new Error("Invalid local time or time zone"), { code: "SCHEDULE_TIME_INVALID" });
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const wanted = formatLocal({ year, month, day, hour, minute });
  // Candidate offsets: the zone offsets around the naive instant.
  const offsets = [...new Set([zoneOffsetMs(naive - 86400000, timeZone), zoneOffsetMs(naive, timeZone), zoneOffsetMs(naive + 86400000, timeZone)])];
  const matches = offsets
    .map((offset) => naive - offset)
    .filter((candidate) => formatLocal(wallClock(candidate, timeZone)) === wanted)
    .sort((a, b) => a - b);
  if (!matches.length) throw Object.assign(new Error(`${wanted} does not exist in ${timeZone} (daylight saving gap)`), { code: "SCHEDULE_TIME_NONEXISTENT" });
  return { utc: new Date(matches[0]), ambiguous: matches.length > 1 };
}

function localDateParts(instantMs, timeZone) {
  return wallClock(instantMs, timeZone);
}

/**
 * Next occurrence strictly after `afterMs` for a recurring schedule:
 * { frequency: daily|weekly|monthly, localTime: "HH:mm", timeZone, weekday (0=Sun..6), dayOfMonth (1..28) }.
 * Non-existent local times on DST-gap days are skipped to the next valid day.
 */
function nextOccurrence(schedule, afterMs) {
  const { frequency, localTime, timeZone } = schedule;
  if (!/^\d{2}:\d{2}$/.test(String(localTime || "")) || !isValidTimeZone(timeZone)) return null;
  const start = localDateParts(afterMs, timeZone);
  let cursor = Date.UTC(start.year, start.month - 1, start.day);
  for (let index = 0; index < 400; index += 1, cursor += 86400000) {
    const date = new Date(cursor);
    const weekday = date.getUTCDay();
    const dayOfMonth = date.getUTCDate();
    if (frequency === "weekly" && weekday !== Number(schedule.weekday)) continue;
    if (frequency === "monthly" && dayOfMonth !== Number(schedule.dayOfMonth)) continue;
    if (!["daily", "weekly", "monthly"].includes(frequency)) return null;
    const local = `${date.toISOString().slice(0, 10)}T${localTime}`;
    try {
      const { utc } = zonedLocalToUtc(local, timeZone);
      if (utc.getTime() > afterMs) return utc;
    } catch (error) {
      if (error.code !== "SCHEDULE_TIME_NONEXISTENT") throw error;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gap 4: recipient-timezone delivery for automations (spec section 14).
// Delivery times never fail on DST: unlike campaign scheduling (which rejects
// a non-existent local time so the author picks another), an automation step
// must still run, so
// - a non-existent local time (spring-forward gap) shifts FORWARD by the gap
//   length (02:30 on the New York gap day runs at 03:30 EDT);
// - an ambiguous local time (fall-back overlap) uses the FIRST occurrence;
// - calendar arithmetic is done on the local date (Date.UTC day overflow), so
//   month ends, Feb 29 and year ends roll over correctly.
// ISO weekdays: 1 = Monday ... 7 = Sunday.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
// Recipient-timezone schedules: an occurrence's local date starts first in the
// easternmost zone (UTC+14); each recipient then waits for that date's local
// time in their own zone.
const EARLIEST_ZONE = "Pacific/Kiritimati";
const ZONE_SPECIAL = new Set(["recipient", "brand"]);

const pad2 = (value) => String(value).padStart(2, "0");
const minutesOf = (hhmm) => {
  const match = HHMM.exec(String(hhmm || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

function isoWeekday(year, month, day) {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

// "YYYY-MM-DDTHH:mm:ss+hh:mm" for an instant in a zone (UI and audit display).
function localIso(instantMs, timeZone) {
  const w = wallClock(instantMs, timeZone);
  const offset = Math.round(zoneOffsetMs(instantMs, timeZone) / 60000);
  const sign = offset < 0 ? "-" : "+";
  return `${formatLocal(w)}:${pad2(w.second)}${sign}${pad2(Math.floor(Math.abs(offset) / 60))}:${pad2(Math.abs(offset) % 60)}`;
}

/**
 * Local wall-clock time -> UTC, never throwing on DST:
 * returns { utc, ambiguous, shiftedMinutes } (shiftedMinutes > 0 when the
 * local time fell into a spring-forward gap and was moved forward).
 */
function resolveLocalTime(local, timeZone) {
  try {
    const { utc, ambiguous } = zonedLocalToUtc(local, timeZone);
    return { utc, ambiguous, shiftedMinutes: 0 };
  } catch (error) {
    if (error.code !== "SCHEDULE_TIME_NONEXISTENT") throw error;
  }
  const [year, month, day, hour, minute] = LOCAL.exec(local).slice(1, 6).map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  // In a gap the offset before the transition is the smaller one; reading the
  // wall time with it lands after the transition, i.e. shifted forward.
  const before = Math.min(zoneOffsetMs(naive - 86400000, timeZone), zoneOffsetMs(naive, timeZone), zoneOffsetMs(naive + 86400000, timeZone));
  const utc = naive - before;
  const w = wallClock(utc, timeZone);
  const shiftedMinutes = Math.round((Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - naive) / 60000);
  return { utc: new Date(utc), ambiguous: false, shiftedMinutes };
}

/**
 * First instant >= afterMs whose local time is `localTime` in `timeZone`, on
 * one of the ISO `days` (all days when omitted). Returns
 * { utc, ambiguous, shiftedMinutes } or null.
 */
function nextLocalTimeAtOrAfter(afterMs, localTime, timeZone, days = null) {
  if (minutesOf(localTime) == null || !isValidTimeZone(timeZone)) return null;
  const start = wallClock(afterMs, timeZone);
  for (let index = 0; index <= 8; index += 1) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + index));
    const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    if (days && days.length && !days.includes(isoWeekday(year, month, day))) continue;
    const resolved = resolveLocalTime(`${year}-${pad2(month)}-${pad2(day)}T${localTime}`, timeZone);
    if (resolved.utc.getTime() >= afterMs) return resolved;
  }
  return null;
}

/**
 * Delivery window { start: "HH:mm", end: "HH:mm", days?: [1..7] } in a zone.
 * Inside the window -> the instant itself; otherwise the next window opening
 * (one opening, never a backlog). Returns { at, deferred, shiftedMinutes }.
 */
function applyWindow(instantMs, window, timeZone) {
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  const days = Array.isArray(window.days) && window.days.length ? window.days : null;
  const w = wallClock(instantMs, timeZone);
  const minute = w.hour * 60 + w.minute;
  const dayOk = !days || days.includes(isoWeekday(w.year, w.month, w.day));
  if (dayOk && minute >= start && minute < end) return { at: instantMs, deferred: false, shiftedMinutes: 0 };
  const opening = nextLocalTimeAtOrAfter(instantMs, window.start, timeZone, days);
  return { at: opening ? opening.utc.getTime() : instantMs, deferred: true, shiftedMinutes: opening?.shiftedMinutes || 0 };
}

function contactTimeZoneOf(contact) {
  const value = contact?.attributes && typeof contact.attributes === "object" ? contact.attributes.timezone : null;
  return value == null || value === "" ? null : String(value);
}

/**
 * Which zone a step uses. spec: "recipient" (default) | "brand" | IANA name.
 * Recipient: contact attributes.timezone -> brand default -> UTC; the
 * fallback (and why) is reported so it can be recorded on the step run.
 */
function resolveZone({ spec = "recipient", contactTimeZone = null, brandTimeZone = null } = {}) {
  if (spec && !ZONE_SPECIAL.has(spec)) {
    return isValidTimeZone(spec) ? { timeZone: spec, source: "EXPLICIT", fallback: false, fallbackReason: null } : { timeZone: "UTC", source: "UTC", fallback: true, fallbackReason: "INVALID_STEP_TIMEZONE" };
  }
  const brandOk = isValidTimeZone(brandTimeZone);
  if (spec === "brand") return brandOk ? { timeZone: brandTimeZone, source: "BRAND", fallback: false, fallbackReason: null } : { timeZone: "UTC", source: "UTC", fallback: true, fallbackReason: "BRAND_TIMEZONE_MISSING" };
  if (isValidTimeZone(contactTimeZone)) return { timeZone: contactTimeZone, source: "RECIPIENT", fallback: false, fallbackReason: null };
  const fallbackReason = contactTimeZone ? "RECIPIENT_TIMEZONE_INVALID" : "RECIPIENT_TIMEZONE_MISSING";
  return brandOk ? { timeZone: brandTimeZone, source: "BRAND_DEFAULT", fallback: true, fallbackReason } : { timeZone: "UTC", source: "UTC", fallback: true, fallbackReason };
}

const zoneSummary = (zone) => (zone ? { timeZone: zone.timeZone, timeZoneSource: zone.source, timeZoneFallback: zone.fallback, ...(zone.fallbackReason ? { fallbackReason: zone.fallbackReason } : {}) } : null);

/**
 * Run time of a delay step:
 *   { type: "delay", minutes, until?: { localTime, timezone }, window?: { start, end, days?, timezone } }
 * base = from + minutes; `until` moves it to the next local time at/after the
 * base (on window days when a window is set); `window` then moves it to the
 * next opening if it falls outside. Returns everything the step run records.
 */
function computeDelayRunAt({ fromMs, step, contactTimeZone = null, brandTimeZone = null }) {
  let at = fromMs + Number(step.minutes || 0) * 60000;
  let untilZone = null;
  let windowZone = null;
  let ambiguous = false;
  let shiftedMinutes = 0;
  let windowDeferred = false;
  if (step.until) {
    untilZone = resolveZone({ spec: step.until.timezone || "recipient", contactTimeZone, brandTimeZone });
    const resolved = nextLocalTimeAtOrAfter(at, step.until.localTime, untilZone.timeZone, step.window && (step.window.timezone || "recipient") === (step.until.timezone || "recipient") ? step.window.days : null);
    if (resolved) {
      at = resolved.utc.getTime();
      ambiguous = resolved.ambiguous;
      shiftedMinutes = resolved.shiftedMinutes;
    }
  }
  if (step.window) {
    windowZone = resolveZone({ spec: step.window.timezone || "recipient", contactTimeZone, brandTimeZone });
    const windowed = applyWindow(at, step.window, windowZone.timeZone);
    windowDeferred = windowed.deferred;
    if (windowed.deferred) shiftedMinutes = windowed.shiftedMinutes;
    at = windowed.at;
  }
  const zone = windowZone || untilZone;
  return {
    runAt: new Date(at),
    baseRunAt: new Date(fromMs + Number(step.minutes || 0) * 60000),
    ...(zone ? { ...zoneSummary(zone), localRunAt: localIso(at, zone.timeZone) } : { timeZone: null, localRunAt: null }),
    ...(untilZone && windowZone && untilZone.timeZone !== windowZone.timeZone ? { untilTimeZone: untilZone.timeZone } : {}),
    ambiguous,
    shiftedMinutes,
    windowDeferred,
  };
}

/**
 * Recipient-local run time for a "recipient" schedule occurrence: the
 * occurrence's local date (in the earliest zone) at the schedule's local time
 * in the recipient's zone.
 */
function recipientScheduleRunAt(occurrence, triggerConfig, zone) {
  const w = wallClock(new Date(occurrence).getTime(), EARLIEST_ZONE);
  const localDate = `${w.year}-${pad2(w.month)}-${pad2(w.day)}`;
  const resolved = resolveLocalTime(`${localDate}T${triggerConfig.localTime}`, zone.timeZone);
  return { runAt: resolved.utc, localDate, localRunAt: localIso(resolved.utc.getTime(), zone.timeZone), ambiguous: resolved.ambiguous, shiftedMinutes: resolved.shiftedMinutes, ...zoneSummary(zone) };
}

// A schedule with timeZone "recipient" finds its occurrences in the earliest zone.
function scheduleForOccurrences(triggerConfig) {
  return triggerConfig.timeZone === "recipient" ? { ...triggerConfig, timeZone: EARLIEST_ZONE } : triggerConfig;
}

module.exports = {
  isValidTimeZone, zonedLocalToUtc, nextOccurrence, zoneOffsetMs, localDateParts,
  // gap 4
  resolveLocalTime, nextLocalTimeAtOrAfter, applyWindow, resolveZone, contactTimeZoneOf, computeDelayRunAt, recipientScheduleRunAt, scheduleForOccurrences, localIso, isoWeekday, minutesOf, zoneSummary, EARLIEST_ZONE,
};

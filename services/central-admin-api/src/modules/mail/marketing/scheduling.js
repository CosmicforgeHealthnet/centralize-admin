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

module.exports = { isValidTimeZone, zonedLocalToUtc, nextOccurrence, zoneOffsetMs, localDateParts };

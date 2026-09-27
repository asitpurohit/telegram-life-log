// All user-facing dates/times are pinned to one timezone so the bot behaves
// the same locally (IST) and on a UTC server (e.g. Vercel).
export const APP_TIMEZONE = process.env.APP_TIMEZONE || "Asia/Kolkata";

// YYYY-MM-DD in the app timezone (used for log_date)
export function localDateString(date: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// e.g. "09:46 PM" (or with seconds: "09:46:12 PM")
export function localTimeString(date: Date = new Date(), withSeconds = false): string {
  return date.toLocaleTimeString("en-US", {
    timeZone: APP_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    ...(withSeconds ? { second: "2-digit" } : {}),
  });
}

// "HH:MM:SS" in the app timezone (used to match reminder_time)
export function localHHMMSS(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value || "00";
  return `${get("hour")}:${get("minute")}:${get("second")}`;
}

// e.g. "Friday, Sep 25"
export function localDateLabel(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "short",
  }).format(date);
}

export function localWeekday(date: Date = new Date()): { short: string; long: string } {
  return {
    short: new Intl.DateTimeFormat("en-US", { timeZone: APP_TIMEZONE, weekday: "short" }).format(date),
    long: new Intl.DateTimeFormat("en-US", { timeZone: APP_TIMEZONE, weekday: "long" }).format(date),
  };
}

function timeZoneOffsetMs(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - date.getTime();
}

// Builds a real Date from a wall-clock date ("YYYY-MM-DD") + time ("HH:MM[:SS]")
// interpreted in the app timezone.
export function zonedDateTimeToUtc(dateStr: string, timeStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm, ss = 0] = timeStr.split(":").map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, hh, mm, ss);
  const offset = timeZoneOffsetMs(new Date(utcGuess));
  return new Date(utcGuess - offset);
}

// e.g. "Today 08:00 PM", "Tomorrow 09:00 AM", "Sat, Sep 27 06:30 PM"
export function todoDueLabel(iso: string): string {
  const due = new Date(iso);
  const dueDate = localDateString(due);
  const today = localDateString();
  const tomorrow = localDateString(new Date(Date.now() + 86400000));
  const time = localTimeString(due);

  if (dueDate === today) return `Today ${time}`;
  if (dueDate === tomorrow) return `Tomorrow ${time}`;

  const datePart = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(due);
  return `${datePart} ${time}`;
}

// Shift a YYYY-MM-DD date by N days (safe UTC arithmetic).
export function shiftDateString(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

// e.g. "Sep 26" for a YYYY-MM-DD date in the app timezone
export function localDateShort(dateStr: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE,
    day: "numeric",
    month: "short",
  }).format(zonedDateTimeToUtc(dateStr, "12:00:00"));
}

export interface SessionPart {
  date: string; // YYYY-MM-DD (app timezone)
  minutes: number;
}

// Split a completed session's worked minutes across the IST days its wall
// window touches: fill each day up to the wall-clock minutes that fell in it,
// sequentially. Zero-minute parts are dropped and the sum always equals
// workedMinutes (leftover, if any, is added to the last part).
export function splitSessionMinutes(
  startedAtMs: number,
  endMs: number,
  workedMinutes: number
): SessionPart[] {
  const total = Math.max(1, Math.round(workedMinutes));
  const startDate = localDateString(new Date(startedAtMs));
  if (endMs <= startedAtMs) return [{ date: startDate, minutes: total }];

  const endDate = localDateString(new Date(endMs));
  const parts: SessionPart[] = [];
  let remaining = total;
  let date = startDate;

  while (date <= endDate) {
    const dayStartMs = zonedDateTimeToUtc(date, "00:00:00").getTime();
    const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
    const wallMs = Math.max(0, Math.min(endMs, dayEndMs) - Math.max(startedAtMs, dayStartMs));
    const wallMin = Math.floor(wallMs / 60000);

    const part = Math.min(remaining, wallMin);
    if (part > 0) {
      parts.push({ date, minutes: part });
      remaining -= part;
    }
    if (remaining <= 0) break;
    date = shiftDateString(date, 1);
  }

  if (remaining > 0) {
    if (parts.length === 0) parts.push({ date: endDate, minutes: remaining });
    else parts[parts.length - 1].minutes += remaining;
  }
  return parts;
}

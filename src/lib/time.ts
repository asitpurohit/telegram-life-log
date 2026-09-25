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

import { localDateString, localHHMMSS, localWeekday, zonedDateTimeToUtc } from "./time";
import type { Log, Task } from "./types";

export interface SleepInterval {
  startMs: number;
  endMs: number;
}

export interface TickEvent {
  task: string; // "Sleep" | "Wakeup"
  atMs: number;
}

export interface WastedDay {
  date: string; // YYYY-MM-DD
  elapsedMin: number; // 1440 for past days, now - midnight for today
  timerMin: number; // sum of timer-task values logged that day
  sleepMin: number; // sleep credited to this day (intervals + fallbacks)
  wastedMin: number; // elapsed - timer - sleep, clamped at 0
  estimated: boolean; // true when a reminder fallback contributed
  tracked: boolean; // true when a Sleep/Wakeup task exists
  isToday: boolean;
}

const MAX_SLEEP_MS = 16 * 60 * 60 * 1000;
const DAY_MIN = 24 * 60;

// A Sleep tick only starts a night sleep if it is in the evening or the small
// hours (18:00 - 11:59). Afternoon nap ticks are ignored: without a wake event
// they cannot be measured and would otherwise swallow the rest of the day.
function isNightSleepStart(atMs: number): boolean {
  const hour = Number(localHHMMSS(new Date(atMs)).slice(0, 2));
  return hour >= 18 || hour < 12;
}

// Pair each night Sleep tick with the next Wakeup tick (within 16h). A recent
// unpaired Sleep tick is treated as ongoing sleep until `nowMs`.
export function buildSleepIntervals(
  events: TickEvent[],
  sleepName: string | null,
  wakeName: string | null,
  nowMs: number
): SleepInterval[] {
  if (!sleepName || !wakeName) return [];

  const sorted = [...events].sort((a, b) => a.atMs - b.atMs);
  const intervals: SleepInterval[] = [];
  let pendingSleep: number | null = null;

  for (const ev of sorted) {
    if (ev.task === sleepName) {
      if (isNightSleepStart(ev.atMs)) pendingSleep = ev.atMs;
    } else if (ev.task === wakeName && pendingSleep !== null) {
      if (ev.atMs - pendingSleep <= MAX_SLEEP_MS) {
        intervals.push({ startMs: pendingSleep, endMs: ev.atMs });
      }
      pendingSleep = null;
    }
  }

  if (pendingSleep !== null && nowMs - pendingSleep > 0 && nowMs - pendingSleep <= MAX_SLEEP_MS) {
    intervals.push({ startMs: pendingSleep, endMs: nowMs });
  }

  return intervals;
}

// Shift a YYYY-MM-DD date by N days (safe UTC arithmetic).
export function shiftDateString(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function isScheduledOn(targetDays: string | null | undefined, midday: Date): boolean {
  if (!targetDays || targetDays === "daily" || targetDays.toLowerCase() === "every day") return true;
  const { short, long } = localWeekday(midday);
  const s = short.toLowerCase();
  if (targetDays === "weekdays") return ["mon", "tue", "wed", "thu", "fri"].includes(s);
  if (targetDays === "weekends") return ["sat", "sun"].includes(s);
  const days = targetDays.split(",").map((d) => d.trim().toLowerCase());
  return days.includes(s) || days.includes(long.toLowerCase());
}

// Computes per-day wasted time for each date:
//   wasted = elapsed (24h for past days, midnight->now for today)
//            - timer-type task minutes
//            - sleep credited to that day (Sleep->Wakeup interval overlaps,
//              reminder fallbacks when ticks are missing)
// Feed logs spanning dates[0]-1 .. dates[-1]+1 so night intervals close.
export function computeWastedDays(opts: {
  dates: string[];
  logs: Log[];
  tasks: Task[];
  nowMs?: number;
}): WastedDay[] {
  const nowMs = opts.nowMs ?? Date.now();
  const today = localDateString(new Date(nowMs));

  const sleepTask = opts.tasks.find((t) => t.type === "tick" && /sleep/i.test(t.name)) || null;
  const wakeTask = opts.tasks.find((t) => t.type === "tick" && /wake/i.test(t.name)) || null;
  const tracked = !!sleepTask || !!wakeTask;
  const timerNames = new Set(opts.tasks.filter((t) => t.type === "timer").map((t) => t.name));

  const events: TickEvent[] = [];
  for (const l of opts.logs) {
    if (!l.created_at) continue;
    if (sleepTask && l.task_name === sleepTask.name) {
      events.push({ task: l.task_name, atMs: new Date(l.created_at).getTime() });
    } else if (wakeTask && l.task_name === wakeTask.name) {
      events.push({ task: l.task_name, atMs: new Date(l.created_at).getTime() });
    }
  }

  const intervals = buildSleepIntervals(events, sleepTask?.name ?? null, wakeTask?.name ?? null, nowMs);
  const wakeReminderMin = reminderTimeToMinutes(wakeTask?.reminder_time);
  const sleepReminderMin = reminderTimeToMinutes(sleepTask?.reminder_time);

  const days: WastedDay[] = [];

  for (const date of opts.dates) {
    const isToday = date === today;
    const isPast = date < today;
    if (!isToday && !isPast) continue; // future dates have no data

    const midnightMs = zonedDateTimeToUtc(date, "00:00:00").getTime();
    const elapsedMin = isToday ? Math.max(0, Math.floor((nowMs - midnightMs) / 60000)) : DAY_MIN;
    const dayEndMs = midnightMs + elapsedMin * 60000;

    let timerMin = 0;
    for (const l of opts.logs) {
      if (l.log_date === date && timerNames.has(l.task_name)) timerMin += l.value || 0;
    }

    let sleepMs = 0;
    let morningCovered = false; // a tracked night/sleep already explains this day's wake
    let eveningCovered = false; // this day's evening sleep is tracked

    for (const iv of intervals) {
      const startHour = Number(localHHMMSS(new Date(iv.startMs)).slice(0, 2));
      const startsThisEvening = iv.startMs >= midnightMs && iv.startMs < dayEndMs && startHour >= 18;
      const isMorningSlot = !startsThisEvening && (iv.startMs < midnightMs || startHour < 12);
      if (!startsThisEvening && !isMorningSlot) continue; // mid-day starts cannot happen (nap guard)

      const s = Math.max(iv.startMs, midnightMs);
      const e = Math.min(iv.endMs, dayEndMs);
      if (e > s) sleepMs += e - s;

      if (startsThisEvening) eveningCovered = true;
      else morningCovered = true;
    }

    let wakeTickAtMs: number | null = null;
    for (const ev of events) {
      if (localDateString(new Date(ev.atMs)) !== date) continue;
      if (wakeTask && ev.task === wakeTask.name) wakeTickAtMs = ev.atMs;
    }

    let estimated = false;
    const midday = new Date(midnightMs + 12 * 3600000);
    const elapsedMs = elapsedMin * 60000;

    if (!morningCovered) {
      let added = 0;
      if (wakeTickAtMs !== null) {
        added = Math.min(Math.max(0, wakeTickAtMs - midnightMs), elapsedMs);
      } else if (wakeTask && isScheduledOn(wakeTask.target_days, midday) && wakeReminderMin !== null) {
        added = Math.min(wakeReminderMin, elapsedMin) * 60000;
        if (added > 0) estimated = true;
      }
      sleepMs += added;
    }

    if (!eveningCovered && sleepTask && isScheduledOn(sleepTask.target_days, midday) && sleepReminderMin !== null) {
      const reminderMs = midnightMs + sleepReminderMin * 60000;
      const added = Math.max(0, dayEndMs - Math.max(reminderMs, midnightMs));
      if (added > 0) {
        sleepMs += added;
        estimated = true;
      }
    }

    const sleepMin = Math.min(elapsedMin, Math.floor(sleepMs / 60000));
    const wastedMin = Math.max(0, elapsedMin - Math.max(0, timerMin) - sleepMin);

    days.push({ date, elapsedMin, timerMin, sleepMin, wastedMin, estimated, tracked, isToday });
  }

  return days;
}

// 315 -> "5h 15m", 45 -> "45m"
export function formatMinutes(totalMinutes: number): string {
  const min = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// "05:00:00" -> 300 (minutes since midnight)
export function reminderTimeToMinutes(reminderTime?: string | null): number | null {
  if (!reminderTime) return null;
  const [hh, mm] = reminderTime.split(":").map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 60 + mm;
}

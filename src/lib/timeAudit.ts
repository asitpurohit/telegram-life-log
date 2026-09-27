import { localDateString, zonedDateTimeToUtc, splitSessionMinutes } from "./time";
import type { Log, Task } from "./types";

export { shiftDateString } from "./time";

// A currently running timer session (read from active_timers + pause state).
export interface RunningSession {
  taskName: string;
  startedAtMs: number;
  pausedAtMs: number | null;
  pausedSeconds: number;
}

export interface WastedDay {
  date: string; // YYYY-MM-DD
  elapsedMin: number; // 1440 for past days, now - midnight for today
  sleepMin: number; // Sleep-task minutes (real sessions + running share only)
  taskMin: number; // every other timer task's minutes
  wastedMin: number; // elapsed - tracked, clamped at 0
  tracked: boolean; // true when the Sleep system task exists
  isToday: boolean;
}

const DAY_MIN = 24 * 60;

// Wasted time = elapsed - tracked time, where tracked time is every timer
// session that overlaps the day (Sleep included; split rows from a crossing
// night already carry their per-day minutes) plus the live share of a running
// session. Only real sessions count: if the Sleep timer was not used, that
// time is simply wasted - never estimated.
export function computeWastedDays(opts: {
  dates: string[];
  logs: Log[];
  tasks: Task[];
  nowMs?: number;
  running?: RunningSession | null;
}): WastedDay[] {
  const nowMs = opts.nowMs ?? Date.now();
  const today = localDateString(new Date(nowMs));

  const sleepTask = opts.tasks.find((t) => t.is_system === true || /sleep/i.test(t.name)) || null;
  const tracked = !!sleepTask;
  const timerNames = new Set(opts.tasks.filter((t) => t.type === "timer").map((t) => t.name));
  if (opts.running) timerNames.add(opts.running.taskName);

  const days: WastedDay[] = [];

  for (const date of opts.dates) {
    const isToday = date === today;
    const isPast = date < today;
    if (!isToday && !isPast) continue; // future dates have no data

    const dayStartMs = zonedDateTimeToUtc(date, "00:00:00").getTime();
    const elapsedMin = isToday ? Math.max(0, Math.floor((nowMs - dayStartMs) / 60000)) : DAY_MIN;

    // Completed timer rows + manual timer logs are already attributed per day.
    let otherTimerMin = 0;
    let sleepActualMin = 0;
    for (const l of opts.logs) {
      if (l.log_date !== date || !timerNames.has(l.task_name)) continue;
      const v = l.value || 0;
      if (sleepTask && l.task_name === sleepTask.name) sleepActualMin += v;
      else otherTimerMin += v;
    }

    // The running session's live share of this day.
    let runningSleepMin = 0;
    if (opts.running && timerNames.has(opts.running.taskName)) {
      const endEff = opts.running.pausedAtMs ?? nowMs;
      const workedMs = Math.max(
        0,
        endEff - opts.running.startedAtMs - opts.running.pausedSeconds * 1000
      );
      if (workedMs > 0) {
        const workedMin = Math.max(1, Math.floor(workedMs / 60000));
        const parts = splitSessionMinutes(opts.running.startedAtMs, endEff, workedMin);
        const part = parts.find((p) => p.date === date);
        if (part) {
          if (sleepTask && opts.running.taskName === sleepTask.name) runningSleepMin += part.minutes;
          else otherTimerMin += part.minutes;
        }
      }
    }

    const sleepMin = Math.max(0, sleepActualMin + runningSleepMin);
    const taskMin = Math.max(0, otherTimerMin);
    const wastedMin = Math.max(0, elapsedMin - sleepMin - taskMin);

    days.push({ date, elapsedMin, sleepMin, taskMin, wastedMin, tracked, isToday });
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

// Standard Telegram display for timer durations:
//   45 -> "45 mins" | 60 -> "1 hour" | 62 -> "1 hour 2 min" | 420 -> "7 hours"
export function formatTimerMinutes(totalMinutes: number): string {
  const min = Math.max(0, Math.round(totalMinutes));
  if (min < 60) return `${min} mins`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  const hours = `${h} hour${h > 1 ? "s" : ""}`;
  return m === 0 ? hours : `${hours} ${m} min`;
}

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
  sleepMin: number; // Sleep-task minutes credited (actual + estimated fallback)
  taskMin: number; // every other timer task's minutes
  wastedMin: number; // elapsed - tracked, clamped at 0
  estimated: boolean; // true when a reminder-window estimate contributed
  tracked: boolean; // true when the Sleep system task exists
  isToday: boolean;
}

const DAY_MIN = 24 * 60;
const EST_MORNING_END = 5 * 60; // estimate window 00:00 -> 05:00
const EST_EVENING_START = 22 * 60; // estimate window 22:00 -> 24:00

function overlapMs(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

// Completed timer sessions carry started_at; each session's wall window is
// [started_at, created_at]. Split rows of one crossing session share the same
// window, so sessions are deduped by (task_name, started_at, created_at).
function buildSessionWindows(
  logs: Log[]
): Array<{ taskName: string; startMs: number; endMs: number }> {
  const seen = new Set<string>();
  const windows: Array<{ taskName: string; startMs: number; endMs: number }> = [];

  for (const l of logs) {
    if (!l.started_at || !l.created_at) continue;
    const key = `${l.task_name}|${l.started_at}|${l.created_at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    windows.push({
      taskName: l.task_name,
      startMs: new Date(l.started_at).getTime(),
      endMs: new Date(l.created_at).getTime(),
    });
  }
  return windows;
}

// Wasted time = elapsed - tracked time, where tracked time is every timer
// session that overlaps the day (Sleep included; split rows already carry
// their per-day minutes) plus the live share of a running session. If no
// Sleep session covers the 22:00-05:00 night, an estimate is added and
// flagged so the caller can show "~ (est.)".
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

  const windows = buildSessionWindows(opts.logs);
  const sleepWindows = sleepTask ? windows.filter((w) => w.taskName === sleepTask.name) : [];

  const days: WastedDay[] = [];

  for (const date of opts.dates) {
    const isToday = date === today;
    const isPast = date < today;
    if (!isToday && !isPast) continue; // future dates have no data

    const dayStartMs = zonedDateTimeToUtc(date, "00:00:00").getTime();
    const elapsedMin = isToday ? Math.max(0, Math.floor((nowMs - dayStartMs) / 60000)) : DAY_MIN;
    const dayEndMs = dayStartMs + elapsedMin * 60000;

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

    // Estimated sleep fallback: credit the 22:00->05:00 night when no Sleep
    // session covers it (forgotten to start the timer).
    let estMin = 0;
    let estimated = false;
    if (sleepTask && elapsedMin > 0) {
      const runEnd = opts.running ? opts.running.pausedAtMs ?? nowMs : 0;
      const runningIsSleep = !!opts.running && opts.running.taskName === sleepTask.name;

      const morningEndMs = dayStartMs + Math.min(EST_MORNING_END, elapsedMin) * 60000;
      const morningCovered =
        sleepWindows.some((w) => overlapMs(w.startMs, w.endMs, dayStartMs, morningEndMs) > 0) ||
        (runningIsSleep && overlapMs(opts.running!.startedAtMs, runEnd, dayStartMs, morningEndMs) > 0);
      if (!morningCovered) {
        estMin += EST_MORNING_END;
        estimated = true;
      }

      const eveningStartMs = dayStartMs + EST_EVENING_START * 60000;
      const eveningCovered =
        sleepWindows.some((w) => overlapMs(w.startMs, w.endMs, eveningStartMs, dayEndMs) > 0) ||
        (runningIsSleep && overlapMs(opts.running!.startedAtMs, runEnd, eveningStartMs, dayEndMs) > 0);

      // If the next night's sleep only started after midnight (00:00-11:59),
      // this evening was genuinely awake: don't credit the estimate.
      const earlyNextSleep =
        sleepWindows.some(
          (w) => w.startMs >= dayEndMs && w.startMs < dayEndMs + 12 * 60 * 60 * 1000
        ) ||
        (runningIsSleep &&
          opts.running!.startedAtMs >= dayEndMs &&
          opts.running!.startedAtMs < dayEndMs + 12 * 60 * 60 * 1000);

      if (!eveningCovered && !earlyNextSleep) {
        estMin += Math.max(0, Math.floor((dayEndMs - eveningStartMs) / 60000));
        estimated = true;
      }

      estMin = Math.min(estMin, Math.max(0, elapsedMin));
      if (estMin <= 0) estimated = false;
    }

    const sleepMin = Math.max(0, sleepActualMin + runningSleepMin + estMin);
    const taskMin = Math.max(0, otherTimerMin);
    const trackedTotal = sleepActualMin + runningSleepMin + otherTimerMin + estMin;
    const wastedMin = Math.max(0, elapsedMin - trackedTotal);

    days.push({ date, elapsedMin, sleepMin, taskMin, wastedMin, estimated, tracked, isToday });
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

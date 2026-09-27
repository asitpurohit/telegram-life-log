export interface TimeAuditInput {
  nowMs: number;
  midnightMs: number;
  timerMin: number;
  wakeTickAtMs?: number | null;
  wakeReminderMin?: number | null;
  wakeScheduledToday?: boolean;
}

export interface TimeAuditResult {
  elapsedMin: number;
  sleepMin: number;
  wastedMin: number;
  sleepIsEstimate: boolean;
  wakeLogged: boolean;
}

// Wasted = elapsed (00:00 -> now) - today's timer minutes - sleep for today
// Sleep for today = wake time - 00:00. Wake time priority:
//   1. today's Wake Up tick (exact tap time)
//   2. the Wake task's reminder time, if it is scheduled today (estimated)
//   3. otherwise 0
export function computeTodayAudit(input: TimeAuditInput): TimeAuditResult {
  const elapsedMin = Math.max(0, Math.floor((input.nowMs - input.midnightMs) / 60000));

  let sleepMin = 0;
  let sleepIsEstimate = false;
  let wakeLogged = false;

  if (typeof input.wakeTickAtMs === "number" && input.wakeTickAtMs > 0) {
    sleepMin = Math.floor((input.wakeTickAtMs - input.midnightMs) / 60000);
    wakeLogged = true;
  } else if (
    input.wakeScheduledToday &&
    typeof input.wakeReminderMin === "number" &&
    input.wakeReminderMin >= 0
  ) {
    sleepMin = input.wakeReminderMin;
    sleepIsEstimate = true;
  }

  sleepMin = Math.min(Math.max(0, sleepMin), elapsedMin);
  const wastedMin = Math.max(0, elapsedMin - Math.max(0, input.timerMin) - sleepMin);

  return { elapsedMin, sleepMin, wastedMin, sleepIsEstimate, wakeLogged };
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

import {
  getActiveTasks,
  isTaskScheduledForToday,
  isTaskCompletedToday,
  getTodayTaskTotal,
  getTodayTaskFocus,
  taskEmoji,
  getLogsInRange,
  getActiveTimer,
  getPauseState,
  formatMoodDisplay,
  getTodos,
  getDailyTodosForTask,
  getIdleSnoozeState,
} from "./supabase";
import { formatTimerMinutes, computeWastedDays } from "./timeAudit";
import {
  localDateLabel,
  localDateString,
  localTimeString,
  shiftDateString,
} from "./time";

// Format "HH:MM:SS" to readable "08:00 AM"
export function formatReminderTime(timeStr?: string | null): string {
  if (!timeStr) return "None";
  const parts = timeStr.split(":");
  if (parts.length >= 2) {
    let hours = parseInt(parts[0], 10);
    const minutes = parts[1];
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12;
    if (hours === 0) hours = 12;
    return `${String(hours).padStart(2, "0")}:${minutes} ${ampm}`;
  }
  return timeStr;
}

// Format goal display (e.g. "2 hours" or "1h 30m" or "10 km" or "5,000 ml")
export function formatGoalDisplay(targetValue?: number | null, unit?: string | null): string {
  if (!targetValue) return "None";
  const cleanUnit = unit?.includes("|") ? unit.split("|")[0] : unit;

  if (cleanUnit === "minutes") {
    return formatTimerMinutes(targetValue);
  }
  if (cleanUnit === "status") {
    return "1 completion";
  }
  return `${targetValue.toLocaleString()} ${cleanUnit || "units"}`;
}

export function formatFocusBadge(totals: {
  focused: number;
  casual: number;
  distracted: number;
  tagged: number;
}): string {
  if (!totals.tagged) return "";
  const pct = (v: number) => Math.round((v / totals.tagged) * 100);
  return ` [🎯 ${pct(totals.focused)}% · 😐 ${pct(totals.casual)}% · 😵 ${pct(totals.distracted)}%]`;
}

// Build a clean Today Scorecard containing only today's tasks with reminder times
export async function buildTodayScorecard(chatId: string | number): Promise<string> {
  const todayStr = localDateLabel();

  const allTasks = await getActiveTasks();
  // Filter for only tasks scheduled for today
  const tasks = allTasks.filter((t) => isTaskScheduledForToday(t.target_days));

  let text = `📊 <b>Today's Scorecard</b> — ${todayStr}\n\n`;

  if (allTasks.length === 0) {
    text += `<i>No tasks created yet. Type /addtask to create one!</i>\n`;
  } else if (tasks.length === 0) {
    text += `<i>No tasks scheduled for today. Your other tasks are set for different days.</i>\n`;
  } else {
    text += `<b>Habits & Routines:</b>\n`;
    for (const t of tasks) {
      const reminderTag = t.reminder_time
        ? ` · ⏰ <b>${formatReminderTime(t.reminder_time)}</b>`
        : "";

      if (t.type === "tick") {
        const isDone = await isTaskCompletedToday(t.id);
        text += `${isDone ? "✅" : "📌"} <b>${t.name}</b>: ${isDone ? "<i>(Done)</i>" : "<i>(Pending)</i>"}${reminderTag}\n`;
      } else if (t.type === "timer") {
        const mins = await getTodayTaskTotal(t.name);
        const target = t.target_value || 60;
        const pct = Math.min(100, Math.round((mins / target) * 100));
        const focusBadge = formatFocusBadge(await getTodayTaskFocus(t.name));
        text += `${taskEmoji(t)} <b>${t.name}:</b> ${formatTimerMinutes(mins)} / ${formatGoalDisplay(target, "minutes")} (${pct}%)${reminderTag}${focusBadge}\n`;

        const dailyTodos = await getDailyTodosForTask(t.id, localDateString());
        if (dailyTodos.length > 0) {
          for (const td of dailyTodos) {
            text += `   ${td.is_done ? "✅" : "▫️"} <i>${td.title}</i>\n`;
          }
        }
      } else {
        const val = await getTodayTaskTotal(t.name);
        const target = t.target_value || 5000;
        const pct = Math.min(100, Math.round((val / target) * 100));
        const focusBadge = formatFocusBadge(await getTodayTaskFocus(t.name));
        text += `💧 <b>${t.name}:</b> ${val.toLocaleString()} / ${formatGoalDisplay(target, t.unit)} (${pct}%)${reminderTag}${focusBadge}\n`;
      }
    }
  }

  const today = localDateString();
  const logs = await getLogsInRange(shiftDateString(today, -1), today);

  // Wasted = elapsed (midnight -> now) - tracked timer sessions (Sleep included) - planned offline breaks.
  if (allTasks.length > 0) {
    const active = await getActiveTimer(chatId);
    const pause = await getPauseState(chatId);
    const running = active
      ? {
          taskName: active.task_name,
          startedAtMs: new Date(active.started_at).getTime(),
          pausedAtMs: pause.pausedAt,
          pausedSeconds: pause.pausedSeconds,
        }
      : null;

    const snoozeState = await getIdleSnoozeState(chatId);
    let activeSnoozeMin = 0;
    if (snoozeState && snoozeState.snoozedAt) {
      const now = Date.now();
      const end = new Date(snoozeState.snoozedUntil).getTime();
      if (now < end) {
        activeSnoozeMin = Math.max(0, Math.round((now - new Date(snoozeState.snoozedAt).getTime()) / 60000));
      }
    }

    const [day] = computeWastedDays({ dates: [today], logs, tasks: allTasks, running, snoozeMin: activeSnoozeMin });
    if (day) {
      const sleepLabel = day.tracked ? `😴 ${formatTimerMinutes(day.sleepMin)}` : "😴 not tracked";
      const breakLabel = (day.breakMin || 0) > 0 ? ` · ⏸️ ${formatTimerMinutes(day.breakMin!)} breaks` : "";

      text += `\n🕳️ <b>Wasted:</b> ${formatTimerMinutes(day.wastedMin)} of ${formatTimerMinutes(day.elapsedMin)} <i>(${sleepLabel} · ⏱️ ${formatTimerMinutes(day.taskMin)} tasks${breakLabel})</i>\n`;
    }
  }

  const breakLogs = logs.filter((l) => l.task_name === "Offline Break" && l.log_date === today);
  const currentSnooze = await getIdleSnoozeState(chatId);
  const now = Date.now();
  const isSnoozeLive = Boolean(currentSnooze && currentSnooze.snoozedUntil && now < new Date(currentSnooze.snoozedUntil).getTime());
  if (breakLogs.length > 0 || isSnoozeLive) {
    text += `\n⏸️ <b>Planned Breaks & Offline Snoozes:</b>\n`;
    for (const b of breakLogs) {
      const noteStr = b.summary || b.notes ? ` — <i>${(b.summary || b.notes || "").replace(/^Planned Snooze:\s*/i, "")}</i>` : "";
      text += `• <b>${formatTimerMinutes(b.value || 0)}</b>${noteStr}\n`;
    }
    if (isSnoozeLive && currentSnooze?.snoozedAt) {
      const liveMin = Math.max(1, Math.round((now - new Date(currentSnooze.snoozedAt).getTime()) / 60000));
      const reasonStr = currentSnooze.reason ? ` — <i>${currentSnooze.reason}</i>` : "";
      text += `• <b>${formatTimerMinutes(liveMin)}</b> (in progress)${reasonStr}\n`;
    }
  }

  try {
    const todos = await getTodos();
    const todayTodos = todos.filter(
      (td) => !td.is_done && localDateString(new Date(td.due_at)) === today
    );
    if (todayTodos.length > 0) {
      text += `\n📝 <b>To-Dos Due Today:</b>\n`;
      for (const td of todayTodos) {
        text += `• 📌 <b>${td.title}</b> — ⏰ ${localTimeString(new Date(td.due_at))}\n`;
      }
    }
  } catch {}

  const diaryLogs = logs.filter((l) => l.task_name === "Diary" && l.log_date === today);
  if (diaryLogs.length > 0) {
    text += `\n📖 <b>Today's Diary:</b>\n`;
    for (const d of diaryLogs) {
      const timeStr = d.created_at ? localTimeString(new Date(d.created_at)) : "";
      const moodBadge = d.mood ? `[${formatMoodDisplay(d.mood)}] ` : "";
      text += `• ${timeStr ? `<i>[${timeStr}]</i> ` : ""}${moodBadge}${d.summary || d.notes}\n`;
    }
  }

  return text;
}

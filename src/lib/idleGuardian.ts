import {
  getAllUserSettings,
  updateUserSettings,
  getActiveTimer,
  getPauseState,
  trackIdleAlertMessage,
  getIdleAlertMessage,
  clearIdleAlertState,
  getTodayLogs,
  getActiveTasks,
} from "./supabase";
import {
  sendTelegramMessage,
  deleteTelegramMessage,
  InlineKeyboard,
} from "./telegram";
import { localDateString, localTimeString, localHHMMSS, zonedDateTimeToUtc } from "./time";
import { computeWastedDays, formatTimerMinutes } from "./timeAudit";

export async function clearIdleAlertCard(
  chatId: string | number,
  exceptMessageId?: number
): Promise<void> {
  const prevId = await getIdleAlertMessage(chatId);
  if (prevId && prevId !== exceptMessageId) {
    await deleteTelegramMessage(chatId, prevId);
  }
  await clearIdleAlertState(chatId);
}

// 4-Beep Idle Alert sequence spaced 2.5s apart to trigger multiple physical phone vibrations.
// After the final actionable card lands, preliminary audio pings are cleanly deleted.
export async function sendQuadChimeAlert(
  chatId: string | number,
  ping1: string,
  ping2: string,
  ping3: string,
  finalText: string,
  keyboard?: InlineKeyboard
): Promise<number | undefined> {
  const r1 = await sendTelegramMessage(chatId, ping1);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const r2 = await sendTelegramMessage(chatId, ping2);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const r3 = await sendTelegramMessage(chatId, ping3);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const finalRes = await sendTelegramMessage(chatId, finalText, keyboard);

  // Clean up preliminary audio pings now that sounds have triggered on phone
  if (r1?.result?.message_id) {
    await deleteTelegramMessage(chatId, r1.result.message_id);
  }
  if (r2?.result?.message_id) {
    await deleteTelegramMessage(chatId, r2.result.message_id);
  }
  if (r3?.result?.message_id) {
    await deleteTelegramMessage(chatId, r3.result.message_id);
  }

  return finalRes?.result?.message_id;
}

export function isTimeInWindow(current: string, start: string, end: string): boolean {
  if (start <= end) {
    return current >= start && current <= end;
  }
  // Overnight window, e.g. 22:00 to 05:00
  return current >= start || current <= end;
}

// Background checker called by /api/tick every minute
export async function checkAndSendIdleNudges(): Promise<void> {
  const allSettings = await getAllUserSettings();
  if (allSettings.length === 0) return;

  const now = Date.now();
  const currentLocalTime = localHHMMSS().slice(0, 5); // "HH:MM"

  for (const settings of allSettings) {
    if (!settings.idle_nudge_enabled) continue;

    // 1. Check if snooze is currently active
    if (settings.idle_snoozed_until) {
      const snoozeEnd = new Date(settings.idle_snoozed_until).getTime();
      if (now < snoozeEnd) continue;
    }

    // 2. Check if user is currently inside their active hours window
    const start = settings.idle_window_start || "05:00";
    const end = settings.idle_window_end || "22:00";
    if (!isTimeInWindow(currentLocalTime, start, end)) {
      continue;
    }

    // 3. Check active timer and paused / transition states
    const running = await getActiveTimer(settings.chat_id);
    const pause = await getPauseState(settings.chat_id);
    const isPaused = Boolean(pause.pausedAt && pause.pausedAt > 0);
    const isSleep = Boolean(running && /sleep/i.test(running.task_name));

    // Never alert for Sleep sessions
    if (isSleep) {
      await clearIdleAlertCard(settings.chat_id);
      continue;
    }

    // If timer is on break, legitimate rest countdown is running — stay peaceful
    const phase = running?.pomodoro_phase || "work";
    if (running?.is_pomodoro && phase === "break") {
      await clearIdleAlertCard(settings.chat_id);
      continue;
    }

    // If timer is actively working (not paused, not in transition)
    const isActivelyWorking = running && !isPaused && (!running.is_pomodoro || phase === "work");
    if (isActivelyWorking) {
      await clearIdleAlertCard(settings.chat_id);
      continue;
    }

    // User is in an idle state:
    // a) No timer running at all
    // b) Timer manually paused (isPaused === true)
    // c) Pomodoro focus finished, awaiting break (phase === 'awaiting_break')
    // d) Pomodoro break finished, awaiting round (phase === 'awaiting_round')
    let idleState: "no_timer" | "manually_paused" | "awaiting_break" | "awaiting_round" = "no_timer";
    let idleStreakStartMs = 0;

    const intervalMins = settings.idle_interval_mins || 3;
    const intervalMs = intervalMins * 60 * 1000;
    const lastNudgeMs = settings.last_idle_nudge_at ? new Date(settings.last_idle_nudge_at).getTime() : 0;

    const today = localDateString();
    const todayLogs = await getTodayLogs();
    const allTasks = await getActiveTasks();
    const windowStartUtc = zonedDateTimeToUtc(today, `${start}:00`);
    const windowStartMs = windowStartUtc.getTime();

    if (running) {
      if (running.is_pomodoro && phase === "awaiting_break") {
        idleState = "awaiting_break";
        idleStreakStartMs = new Date(running.phase_started_at || running.started_at).getTime();
      } else if (running.is_pomodoro && phase === "awaiting_round") {
        idleState = "awaiting_round";
        idleStreakStartMs = new Date(running.phase_started_at || running.started_at).getTime();
      } else if (isPaused) {
        idleState = "manually_paused";
        idleStreakStartMs = pause.pausedAt || new Date(running.started_at).getTime();
      }
    } else {
      // Find the latest completed timer session today
      const timerTasks = new Set(allTasks.filter((t) => t.type === "timer").map((t) => t.name));
      const timerLogs = todayLogs.filter((l) => timerTasks.has(l.task_name) && (l.value || 0) > 0);

      let latestSessionEndMs = 0;
      for (const l of timerLogs) {
        let sessionEnd = 0;
        if (l.started_at && l.value) {
          sessionEnd = new Date(l.started_at).getTime() + l.value * 60 * 1000;
        } else if (l.created_at) {
          sessionEnd = new Date(l.created_at).getTime();
        }
        if (sessionEnd > latestSessionEndMs) {
          latestSessionEndMs = sessionEnd;
        }
      }
      idleStreakStartMs = latestSessionEndMs > windowStartMs ? latestSessionEndMs : windowStartMs;
    }

    // 4. Check if the idle interval has elapsed since idle started AND since last nudge
    const elapsedSinceIdleStart = now - idleStreakStartMs;
    const elapsedSinceLastNudge = now - lastNudgeMs;

    if (elapsedSinceIdleStart < intervalMs || elapsedSinceLastNudge < intervalMs) {
      continue;
    }

    // 5. Compute dynamic idle metrics
    const rawStreakMins = Math.floor((now - idleStreakStartMs) / 60000);
    const currentIdleStreakMins = Math.max(intervalMins, rawStreakMins);
    const streakStartTimeStr = localTimeString(new Date(idleStreakStartMs));

    // Total wasted / unaccounted time today via canonical time audit
    const [day] = computeWastedDays({
      dates: [today],
      logs: todayLogs,
      tasks: allTasks,
      nowMs: now,
      running: null,
    });
    const totalWastedTodayMins = Math.max(currentIdleStreakMins, day?.wastedMin ?? currentIdleStreakMins);

    let alertTitle = "🚨 ⏰ 🔔 <b>IDLE ALERT! No timer is running!</b> 🔔 ⏰ 🚨";
    let alertBody = "";
    let alertKb: InlineKeyboard = [];

    const sessionEpoch = running ? new Date(running.started_at).getTime() : 0;
    const workMins = running?.pomodoro_work_mins || 25;
    const breakMins = running?.pomodoro_break_mins || 5;
    const round = running?.pomodoro_round || 1;

    if (idleState === "manually_paused" && running) {
      alertTitle = "🚨 ⏰ 🔔 <b>IDLE ALERT! Timer is Paused!</b> 🔔 ⏰ 🚨";
      alertBody =
        `🍅 <b>${running.task_name}</b> has been paused.\n` +
        `⏳ <b>Paused for:</b> <b>${formatTimerMinutes(currentIdleStreakMins)}</b> <i>(since ${streakStartTimeStr})</i>\n` +
        `📊 <b>Total Idle / Wasted Today:</b> <b>${formatTimerMinutes(totalWastedTodayMins)}</b>\n` +
        `🕒 <i>Active Window: ${start} – ${end}</i>\n\n` +
        `Ready to resume your focus session?`;

      alertKb = [
        [
          { text: "▶️ Resume Focus", callback_data: `timer_resume:${pause.pausedAt || 0}:${sessionEpoch}` },
          { text: "⏹ Stop Timer", callback_data: `timer_stop:${pause.pausedAt || 0}:${sessionEpoch}` },
        ],
        [
          { text: "⏸ Snooze 30m", callback_data: "idle_snooze:30" },
          { text: "⚙️ Settings", callback_data: "menu_settings" },
        ],
      ];
    } else if (idleState === "awaiting_break" && running) {
      alertTitle = "🚨 ⏰ 🔔 <b>IDLE ALERT! Waiting for Break!</b> 🔔 ⏰ 🚨";
      alertBody =
        `🎉 <b>${running.task_name}</b> focus round completed!\n` +
        `⏳ <b>Idle for:</b> <b>${formatTimerMinutes(currentIdleStreakMins)}</b> <i>(since ${streakStartTimeStr})</i>\n` +
        `📊 <b>Total Idle / Wasted Today:</b> <b>${formatTimerMinutes(totalWastedTodayMins)}</b>\n` +
        `🕒 <i>Active Window: ${start} – ${end}</i>\n\n` +
        `Take your ${breakMins}-minute break now to stay fresh!`;

      alertKb = [
        [{ text: `☕ Start ${breakMins}m Break`, callback_data: "pomodoro_start_break" }],
        [
          { text: "▶️ Skip Break & Continue", callback_data: "pomodoro_skip_break" },
          { text: "⏹ Stop Session", callback_data: `timer_stop:${now}:${sessionEpoch}` },
        ],
        [
          { text: "⏸ Snooze 30m", callback_data: "idle_snooze:30" },
          { text: "⚙️ Settings", callback_data: "menu_settings" },
        ],
      ];
    } else if (idleState === "awaiting_round" && running) {
      alertTitle = "🚨 ⏰ 🔔 <b>IDLE ALERT! Break is Over!</b> 🔔 ⏰ 🚨";
      alertBody =
        `🍅 <b>${running.task_name}</b> break has ended!\n` +
        `⏳ <b>Idle for:</b> <b>${formatTimerMinutes(currentIdleStreakMins)}</b> <i>(since ${streakStartTimeStr})</i>\n` +
        `📊 <b>Total Idle / Wasted Today:</b> <b>${formatTimerMinutes(totalWastedTodayMins)}</b>\n` +
        `🕒 <i>Active Window: ${start} – ${end}</i>\n\n` +
        `Ready for <b>Round ${round}</b>? Don't let procrastination win!`;

      alertKb = [
        [{ text: `▶️ Start Round ${round} (${workMins}m)`, callback_data: "pomodoro_next_round" }],
        [{ text: "⏹ Stop & Log Session", callback_data: `timer_stop:${now}:${sessionEpoch}` }],
        [
          { text: "⏸ Snooze 30m", callback_data: "idle_snooze:30" },
          { text: "⚙️ Settings", callback_data: "menu_settings" },
        ],
      ];
    } else {
      // Default: No timer running at all
      alertBody =
        `⏳ <b>Idle for:</b> <b>${formatTimerMinutes(currentIdleStreakMins)}</b> <i>(since ${streakStartTimeStr})</i>\n` +
        `📊 <b>Total Idle / Wasted Today:</b> <b>${formatTimerMinutes(totalWastedTodayMins)}</b>\n` +
        `🕒 <i>Active Window: ${start} – ${end}</i>\n\n` +
        `Don't let procrastination win today — ready to get back to work?`;

      alertKb = [
        [{ text: "📋 View Tasks / Start Timer", callback_data: "menu_tasks" }],
        [
          { text: "⏸ Snooze 30m", callback_data: "idle_snooze:30" },
          { text: "⏸ Snooze 1h", callback_data: "idle_snooze:60" },
        ],
        [{ text: "⚙️ Settings", callback_data: "menu_settings" }],
      ];
    }

    // 6. Send the 4-beep idle alert (replaces any previous idle card so only 1 exists)
    await clearIdleAlertCard(settings.chat_id);

    const finalMsgId = await sendQuadChimeAlert(
      settings.chat_id,
      "⏰ <b>BEEP!</b> (Idle Alert 1/4)",
      "⏰ <b>BEEP!</b> (Idle Alert 2/4)",
      "⏰ <b>BEEP!</b> (Idle Alert 3/4)",
      `${alertTitle}\n\n${alertBody}`,
      alertKb
    );

    if (finalMsgId) {
      await trackIdleAlertMessage(settings.chat_id, finalMsgId);
    }

    // Update last_idle_nudge_at to anchor the next interval
    await updateUserSettings(settings.chat_id, {
      last_idle_nudge_at: new Date(now).toISOString(),
    });
  }
}

import {
  getAllUserSettings,
  updateUserSettings,
  getActiveTimer,
} from "./supabase";
import {
  sendTelegramMessage,
  InlineKeyboard,
} from "./telegram";
import { localHHMMSS } from "./time";

// 4-Beep Idle Alert sequence spaced 2.5s apart to trigger multiple physical phone vibrations
export async function sendQuadChimeAlert(
  chatId: string | number,
  ping1: string,
  ping2: string,
  ping3: string,
  finalText: string,
  keyboard?: InlineKeyboard
): Promise<void> {
  await sendTelegramMessage(chatId, ping1);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  await sendTelegramMessage(chatId, ping2);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  await sendTelegramMessage(chatId, ping3);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  await sendTelegramMessage(chatId, finalText, keyboard);
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

    // 3. Check if any timer is currently running (Study, Sleep, Project, etc.)
    const running = await getActiveTimer(settings.chat_id);
    if (running) {
      continue;
    }

    // 4. Check if the idle interval has elapsed since last nudge/session stop
    const intervalMins = settings.idle_interval_mins || 3;
    const intervalMs = intervalMins * 60 * 1000;
    const lastNudgeMs = settings.last_idle_nudge_at ? new Date(settings.last_idle_nudge_at).getTime() : 0;

    if (now - lastNudgeMs < intervalMs) {
      continue;
    }

    // 5. Send the 4-beep idle alert!
    const alertKb: InlineKeyboard = [
      [{ text: "📋 View Tasks / Start Timer", callback_data: "menu_tasks" }],
      [
        { text: "⏸ Snooze 30m", callback_data: "idle_snooze:30" },
        { text: "⏸ Snooze 1h", callback_data: "idle_snooze:60" },
      ],
      [{ text: "⚙️ Settings", callback_data: "menu_settings" }],
    ];

    await sendQuadChimeAlert(
      settings.chat_id,
      "⏰ <b>BEEP!</b> (Idle Alert 1/4)",
      "⏰ <b>BEEP!</b> (Idle Alert 2/4)",
      "⏰ <b>BEEP!</b> (Idle Alert 3/4)",
      `🚨 ⏰ 🔔 <b>IDLE ALERT! No timer is running!</b> 🔔 ⏰ 🚨\n\n` +
        `You have been idle for <b>${intervalMins} minutes</b> during your active hours (${start} – ${end}).\n\n` +
        `Don't let procrastination win today — ready to get back to work?`,
      alertKb
    );

    // Update last_idle_nudge_at to anchor the next interval
    await updateUserSettings(settings.chat_id, {
      last_idle_nudge_at: new Date(now).toISOString(),
    });
  }
}

import {
  getAllActiveTimers,
  getTimerMessage,
  getPauseState,
  getNudgeState,
  setNudgeState,
} from "./supabase";
import {
  editTelegramMessage,
  sendTelegramMessage,
  deleteTelegramMessage,
  InlineKeyboard,
} from "./telegram";
import { localTimeString } from "./time";

// "Still running" notification interval
export const NUDGE_INTERVAL_MS = 5 * 60 * 1000;

export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// elapsed = (pausedAt ?? now) − started_at − pausedSeconds
export function buildTimerView(
  taskName: string,
  startedAtIso: string,
  pausedAtMs: number,
  pausedSeconds = 0
): { text: string; keyboard: InlineKeyboard } {
  const endMs = pausedAtMs > 0 ? pausedAtMs : Date.now();
  const elapsedSeconds = Math.max(
    0,
    Math.floor((endMs - new Date(startedAtIso).getTime()) / 1000) - pausedSeconds
  );
  const isPaused = pausedAtMs > 0;
  const startedTime = localTimeString(new Date(startedAtIso));
  const emoji = /sleep/i.test(taskName) ? "😴" : "⏱️";

  const text = isPaused
    ? `${emoji} <b>${taskName}</b> — Paused\n` +
      `⏳ Elapsed: <b>${formatDuration(elapsedSeconds)}</b>\n` +
      `🕐 Started: ${startedTime}\n\n` +
      `<i>Paused time is excluded from the final log.</i>`
    : `${emoji} <b>${taskName}</b> — Running\n` +
      `⏳ Elapsed: <b>${formatDuration(elapsedSeconds)}</b>\n` +
      `🕐 Started: ${startedTime}\n\n` +
      `<i>Runs until you stop it.</i>`;

  // Buttons carry the session start so any message of THIS session can be used,
  // while buttons from an older, already-finished session get rejected.
  const sessionEpoch = new Date(startedAtIso).getTime();

  const keyboard: InlineKeyboard = isPaused
    ? [
        [
          { text: "▶️ Resume", callback_data: `timer_resume:${pausedAtMs}:${sessionEpoch}` },
          { text: "⏹ Stop", callback_data: `timer_stop:${pausedAtMs}:${sessionEpoch}` },
        ],
        [{ text: "🔄 Refresh", callback_data: `timer_refresh:${pausedAtMs}:${sessionEpoch}` }],
      ]
    : [
        [
          { text: "⏸ Pause", callback_data: `timer_pause:${sessionEpoch}` },
          { text: "⏹ Stop", callback_data: `timer_stop:0:${sessionEpoch}` },
        ],
        [{ text: "🔄 Refresh", callback_data: `timer_refresh:0:${sessionEpoch}` }],
      ];

  return { text, keyboard };
}

// Called periodically by the local polling runner (5s) and by the Vercel cron
// (/api/tick, 1 min) to make running timers tick and to send "still running"
// notifications every 5 minutes.
export async function refreshRunningTimerMessages(): Promise<void> {
  const timers = await getAllActiveTimers();

  for (const timer of timers) {
    const messageId = await getTimerMessage(timer.chat_id);
    const pause = await getPauseState(timer.chat_id);

    // 1) Keep the live timer view fresh
    if (messageId) {
      const view = buildTimerView(
        timer.task_name,
        timer.started_at,
        pause.pausedAt ?? 0,
        pause.pausedSeconds
      );
      await editTelegramMessage(timer.chat_id, messageId, view.text, view.keyboard);
    }

    // 2) "Still running" nudge every 5 minutes (never while paused).
    //    The system Sleep timer runs all night: no nudges for it.
    if (/sleep/i.test(timer.task_name)) continue;
    if (pause.pausedAt) continue;

    const now = Date.now();
    const nudge = await getNudgeState(timer.chat_id);
    const nextNudgeAt = nudge.nextNudgeAt || new Date(timer.started_at).getTime() + NUDGE_INTERVAL_MS;
    if (now < nextNudgeAt) continue;

    // Replace the previous nudge so only one is ever visible
    if (nudge.messageId) {
      await deleteTelegramMessage(timer.chat_id, nudge.messageId);
    }

    const elapsedSeconds = Math.max(
      0,
      Math.floor((now - new Date(timer.started_at).getTime()) / 1000) - pause.pausedSeconds
    );
    const sent = await sendTelegramMessage(
      timer.chat_id,
      `⏱️ <b>${timer.task_name}</b> is still running — <b>${formatDuration(elapsedSeconds)}</b> elapsed.`
    );

    await setNudgeState(timer.chat_id, {
      messageId: sent?.result?.message_id ?? null,
      nextNudgeAt: now + NUDGE_INTERVAL_MS,
    });
  }
}

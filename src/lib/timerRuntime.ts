import { getAllActiveTimers, getTimerMessage, getPauseState } from "./supabase";
import { editTelegramMessage, InlineKeyboard } from "./telegram";
import { localTimeString } from "./time";

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

  const text = isPaused
    ? `⏸️ <b>${taskName}</b> — Paused\n` +
      `⏳ Elapsed: <b>${formatDuration(elapsedSeconds)}</b>\n` +
      `🕐 Started: ${startedTime}\n\n` +
      `<i>Paused time is excluded from the final log.</i>`
    : `⏱️ <b>${taskName}</b> — Running\n` +
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
// (/api/tick, 1 min) to make running timers tick.
export async function refreshRunningTimerMessages(): Promise<void> {
  const timers = await getAllActiveTimers();

  for (const timer of timers) {
    const messageId = await getTimerMessage(timer.chat_id);
    if (!messageId) continue;

    const pause = await getPauseState(timer.chat_id);
    const view = buildTimerView(
      timer.task_name,
      timer.started_at,
      pause.pausedAt ?? 0,
      pause.pausedSeconds
    );
    await editTelegramMessage(timer.chat_id, messageId, view.text, view.keyboard);
  }
}

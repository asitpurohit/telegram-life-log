import { getAllActiveTimers, getTimerMessage } from "./supabase";
import { editTelegramMessage, InlineKeyboard } from "./telegram";

// In-memory pause state (per chat). Pausing writes NOTHING to the database:
// the paused timestamp travels inside the button callback data, and this map
// only lets the auto-refresher know a timer is currently paused.
const pausedTimers = new Map<string, number>();

export function setTimerPaused(chatId: string | number, pausedAtMs: number): void {
  pausedTimers.set(String(chatId), pausedAtMs);
}

export function clearTimerPaused(chatId: string | number): void {
  pausedTimers.delete(String(chatId));
}

export function getTimerPaused(chatId: string | number): number {
  return pausedTimers.get(String(chatId)) || 0;
}

export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function buildTimerView(
  taskName: string,
  startedAtIso: string,
  pausedAtMs: number
): { text: string; keyboard: InlineKeyboard } {
  const endMs = pausedAtMs > 0 ? pausedAtMs : Date.now();
  const elapsedSeconds = Math.max(0, Math.floor((endMs - new Date(startedAtIso).getTime()) / 1000));
  const isPaused = pausedAtMs > 0;
  const startedTime = new Date(startedAtIso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const text = isPaused
    ? `⏸️ <b>${taskName}</b> — Paused\n` +
      `⏳ Elapsed: <b>${formatDuration(elapsedSeconds)}</b>\n\n` +
      `<i>Pause is local — nothing is saved until you Stop.</i>`
    : `⏱️ <b>${taskName}</b> — Running\n` +
      `⏳ Elapsed: <b>${formatDuration(elapsedSeconds)}</b>\n` +
      `🕐 Started: ${startedTime}\n\n` +
      `<i>Runs until you stop it.</i>`;

  const keyboard: InlineKeyboard = isPaused
    ? [
        [
          { text: "▶️ Resume", callback_data: `timer_resume:${pausedAtMs}` },
          { text: "⏹ Stop & Log", callback_data: `timer_stop:${pausedAtMs}` },
        ],
        [{ text: "🔄 Refresh", callback_data: `timer_refresh:${pausedAtMs}` }],
      ]
    : [
        [
          { text: "⏸ Pause", callback_data: "timer_pause" },
          { text: "⏹ Stop & Log", callback_data: "timer_stop:0" },
        ],
        [{ text: "🔄 Refresh", callback_data: "timer_refresh:0" }],
      ];

  return { text, keyboard };
}

// Called periodically by the local polling runner to make running timers tick.
export async function refreshRunningTimerMessages(): Promise<void> {
  const timers = await getAllActiveTimers();

  for (const timer of timers) {
    const messageId = await getTimerMessage(timer.chat_id);
    if (!messageId) continue;

    const pausedAt = getTimerPaused(timer.chat_id);
    const view = buildTimerView(timer.task_name, timer.started_at, pausedAt);
    await editTelegramMessage(timer.chat_id, messageId, view.text, view.keyboard);
  }
}

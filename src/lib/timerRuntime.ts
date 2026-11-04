import {
  getAllActiveTimers,
  getTimerMessage,
  getPauseState,
  setPauseState,
  getNudgeState,
  setNudgeState,
  clearNudgeState,
  updateActiveTimer,
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

export interface PomodoroInfo {
  isPomodoro: boolean;
  workMins: number;
  breakMins: number;
  round: number;
  phase: "work" | "awaiting_break" | "break";
  phaseStartedAtIso: string;
}

export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function miniProgressBar(percent: number, length: number = 10): string {
  const filled = Math.min(length, Math.max(0, Math.round((percent / 100) * length)));
  return "■".repeat(filled) + "□".repeat(length - filled);
}

// elapsed = (pausedAt ?? now) − started_at − pausedSeconds
export function buildTimerView(
  taskName: string,
  startedAtIso: string,
  pausedAtMs: number,
  pausedSeconds = 0,
  projectName?: string | null,
  projectProgress?: string | null,
  todoTitle?: string | null,
  pomodoro?: PomodoroInfo | null
): { text: string; keyboard: InlineKeyboard } {
  const endMs = pausedAtMs > 0 ? pausedAtMs : Date.now();
  const elapsedSeconds = Math.max(
    0,
    Math.floor((endMs - new Date(startedAtIso).getTime()) / 1000) - pausedSeconds
  );
  const isPaused = pausedAtMs > 0;
  const startedTime = localTimeString(new Date(startedAtIso));
  const emoji = /sleep/i.test(taskName) ? "😴" : pomodoro?.isPomodoro ? (pomodoro.phase === "break" ? "☕" : pomodoro.phase === "awaiting_break" ? "🎉" : "🍅") : "⏱️";

  let projectLine = "";
  if (projectName) {
    projectLine = `\n📦 Project: <b>${projectName}</b>`;
    if (projectProgress) {
      projectLine += `\n📊 Project Progress: <b>${projectProgress}</b>`;
    }
  }

  let taskLine = "";
  if (todoTitle) {
    taskLine = `\n🎯 Task: <b>${todoTitle}</b>`;
  }

  const sessionEpoch = new Date(startedAtIso).getTime();

  // --- Pomodoro Mode Timer View ---
  if (pomodoro?.isPomodoro) {
    const round = pomodoro.round || 1;
    const workMins = pomodoro.workMins || 25;
    const breakMins = pomodoro.breakMins || 5;
    const phaseStartMs = new Date(pomodoro.phaseStartedAtIso || startedAtIso).getTime();

    // Awaiting Break Phase: Focus is completed & paused; waiting for user to start break
    if (pomodoro.phase === "awaiting_break") {
      const text =
        `🎉 <b>${taskName}</b> — Focus Complete! (Round ${round} Done)${projectLine}${taskLine}\n\n` +
        `⏳ Focus Time: <b>${workMins}m / ${workMins}m</b>  [■■■■■■■■■■] 100%\n` +
        `🕐 Started: ${startedTime}\n\n` +
        `✨ <b>Great focus!</b> Work is paused.\n` +
        `Tap <b>Start Break</b> whenever you are ready to take your ${breakMins}-minute break:`;

      const keyboard: InlineKeyboard = [
        [{ text: `☕ Start ${breakMins}m Break`, callback_data: "pomodoro_start_break" }],
        [{ text: "▶️ Skip Break & Continue Work", callback_data: "pomodoro_skip_break" }],
        [{ text: "⏹ Stop & Log Session", callback_data: `timer_stop:${endMs}:${sessionEpoch}` }],
      ];

      return { text, keyboard };
    }

    if (pomodoro.phase === "break") {
      const breakElapsedSec = Math.max(0, Math.floor((Date.now() - phaseStartMs) / 1000));
      const targetBreakSec = breakMins * 60;
      const breakPercent = Math.min(100, Math.round((breakElapsedSec / targetBreakSec) * 100));
      const bar = miniProgressBar(breakPercent, 10);
      const remainingSec = Math.max(0, targetBreakSec - breakElapsedSec);

      const text =
        `☕ <b>${taskName}</b> — On Break! (Round ${round} Done 🎉)${projectLine}${taskLine}\n\n` +
        `⏳ Rest Time: <b>${formatDuration(breakElapsedSec)} / ${formatDuration(targetBreakSec)}</b>  [${bar}]\n` +
        `🕐 Started: ${startedTime}\n\n` +
        `🔔 <i>Alarm will ring in ${formatDuration(remainingSec)} when break ends.\n(Break time is paused and excluded from study hours).</i>`;

      const keyboard: InlineKeyboard = [
        [{ text: "▶️ Skip Break & Resume Work", callback_data: "pomodoro_skip_break" }],
        [{ text: "⏹ Stop & Log", callback_data: `timer_stop:${endMs}:${sessionEpoch}` }],
        [{ text: "🔄 Refresh", callback_data: `timer_refresh:${endMs}:${sessionEpoch}` }],
      ];

      return { text, keyboard };
    }

    // Work Phase
    const currentPhaseElapsedSec = Math.max(0, Math.floor((endMs - phaseStartMs) / 1000));
    const targetWorkSec = workMins * 60;
    const workPercent = Math.min(100, Math.round((currentPhaseElapsedSec / targetWorkSec) * 100));
    const bar = miniProgressBar(workPercent, 10);
    const remainingSec = Math.max(0, targetWorkSec - currentPhaseElapsedSec);

    const text = isPaused
      ? `🍅 <b>${taskName}</b> — Focus Paused (Round ${round})${projectLine}${taskLine}\n\n` +
        `⏳ Focus Time: <b>${formatDuration(currentPhaseElapsedSec)} / ${formatDuration(targetWorkSec)}</b>  [${bar}] ${workPercent}%\n` +
        `🕐 Started: ${startedTime}\n\n` +
        `<i>Focus is paused. Tap Resume to continue.</i>`
      : `🍅 <b>${taskName}</b> — Focus (Round ${round})${projectLine}${taskLine}\n\n` +
        `⏳ Focus Time: <b>${formatDuration(currentPhaseElapsedSec)} / ${formatDuration(targetWorkSec)}</b>  [${bar}] ${workPercent}%\n` +
        `🕐 Started: ${startedTime}\n\n` +
        `🔔 <i>Auto-pause for a ${breakMins}m break in ${formatDuration(remainingSec)}.</i>`;

    const keyboard: InlineKeyboard = isPaused
      ? [
          [
            { text: "▶️ Resume Focus", callback_data: `timer_resume:${pausedAtMs}:${sessionEpoch}` },
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

  // --- Standard Stopwatch View ---
  const text = isPaused
    ? `${emoji} <b>${taskName}</b> — Paused${projectLine}${taskLine}\n` +
      `⏳ Elapsed: <b>${formatDuration(elapsedSeconds)}</b>\n` +
      `🕐 Started: ${startedTime}\n\n` +
      `<i>Paused time is excluded from the final log.</i>`
    : `${emoji} <b>${taskName}</b> — Running${projectLine}${taskLine}\n` +
      `⏳ Elapsed: <b>${formatDuration(elapsedSeconds)}</b>\n` +
      `🕐 Started: ${startedTime}\n\n` +
      `<i>Runs until you stop it.</i>`;

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

// Triple-Ping alert sequence: sends 3 distinct notifications spaced 2.5s apart
// to allow the phone's notification sound and vibration motor to ring 3 separate times.
// Preliminary audio pings are cleanly auto-deleted once the actionable final card lands.
async function sendTripleChimeAlert(
  chatId: string | number,
  ping1: string,
  ping2: string,
  finalText: string,
  keyboard?: InlineKeyboard
): Promise<number | undefined> {
  const r1 = await sendTelegramMessage(chatId, ping1);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const r2 = await sendTelegramMessage(chatId, ping2);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const finalRes = await sendTelegramMessage(chatId, finalText, keyboard);

  // Clean up preliminary audio pings after sounds have played on phone
  if (r1?.result?.message_id) {
    await deleteTelegramMessage(chatId, r1.result.message_id);
  }
  if (r2?.result?.message_id) {
    await deleteTelegramMessage(chatId, r2.result.message_id);
  }

  return finalRes?.result?.message_id;
}

// Called periodically by the local polling runner (5s) and by the Vercel cron
// (/api/tick, 1 min) to make running timers tick, manage Pomodoro intervals,
// and send "still running" notifications every 5 minutes.
export async function refreshRunningTimerMessages(): Promise<void> {
  const timers = await getAllActiveTimers();

  for (const timer of timers) {
    const messageId = await getTimerMessage(timer.chat_id);
    const pause = await getPauseState(timer.chat_id);
    const now = Date.now();

    // --- Pomodoro Automatic Transitions ---
    let pomodoroInfo: PomodoroInfo | null = null;
    if (timer.is_pomodoro) {
      const workMins = timer.pomodoro_work_mins || 25;
      const breakMins = timer.pomodoro_break_mins || 5;
      const round = timer.pomodoro_round || 1;
      const phase = timer.pomodoro_phase || "work";
      const phaseStartMs = new Date(timer.phase_started_at || timer.started_at).getTime();

      pomodoroInfo = {
        isPomodoro: true,
        workMins,
        breakMins,
        round,
        phase,
        phaseStartedAtIso: timer.phase_started_at || timer.started_at,
      };

      // 1) Work phase completed -> auto-pause & start break
      if (phase === "work" && !pause.pausedAt) {
        const workedSec = Math.max(0, Math.floor((now - phaseStartMs) / 1000));
        if (workedSec >= workMins * 60) {
          const prevNudge = await getNudgeState(timer.chat_id);
          if (prevNudge.messageId) {
            await deleteTelegramMessage(timer.chat_id, prevNudge.messageId);
          }
          await clearNudgeState(timer.chat_id);

          await setPauseState(timer.chat_id, { pausedAt: now, pausedSeconds: pause.pausedSeconds });
          await updateActiveTimer(timer.chat_id, {
            pomodoro_phase: "awaiting_break",
            phase_started_at: new Date(now).toISOString(),
          });

          const sessionEpoch = new Date(timer.started_at).getTime();
          const breakKb: InlineKeyboard = [
            [{ text: `☕ Start ${breakMins}m Break`, callback_data: "pomodoro_start_break" }],
            [{ text: "▶️ Skip Break & Continue Work", callback_data: "pomodoro_skip_break" }],
            [{ text: "⏹ Stop & Log Session", callback_data: `timer_stop:${now}:${sessionEpoch}` }],
          ];

          await sendTripleChimeAlert(
            timer.chat_id,
            "🔔 <b>Ting!</b> (Focus Complete! 1/3)",
            "🔔 <b>Ting!</b> (Time to rest ☕ 2/3)",
            `🔔 <b>Pomodoro Complete! (${workMins} mins)</b>\n\n` +
              `Great focus on <b>${timer.task_name}</b>! 🎉\n` +
              `Work is paused. Tap below whenever you are ready to start your <b>${breakMins}-minute break</b>:`,
            breakKb
          );

          pomodoroInfo = {
            ...pomodoroInfo,
            phase: "awaiting_break",
            phaseStartedAtIso: new Date(now).toISOString(),
          };

          if (messageId) {
            const updatedView = buildTimerView(
              timer.task_name,
              timer.started_at,
              now,
              pause.pausedSeconds,
              timer.project_name,
              null,
              timer.todo_title,
              pomodoroInfo
            );
            await editTelegramMessage(timer.chat_id, messageId, updatedView.text, updatedView.keyboard);
          }
          continue;
        }
      } else if (phase === "break") {
        // 2) Break phase completed -> sound alarm & prompt for next round
        const breakElapsedSec = Math.max(0, Math.floor((now - phaseStartMs) / 1000));
        if (breakElapsedSec >= breakMins * 60) {
          const prevNudge = await getNudgeState(timer.chat_id);
          if (prevNudge.messageId) {
            await deleteTelegramMessage(timer.chat_id, prevNudge.messageId);
          }
          await clearNudgeState(timer.chat_id);

          const newPausedSeconds = pause.pausedSeconds + breakElapsedSec;
          await setPauseState(timer.chat_id, { pausedAt: now, pausedSeconds: newPausedSeconds });
          const nextRound = round + 1;
          await updateActiveTimer(timer.chat_id, {
            pomodoro_phase: "work",
            pomodoro_round: nextRound,
            phase_started_at: new Date(now).toISOString(),
          });

          const sessionEpoch = new Date(timer.started_at).getTime();
          const nextKb: InlineKeyboard = [
            [{ text: `▶️ Start Round ${nextRound} (${workMins}m)`, callback_data: `pomodoro_next_round` }],
            [{ text: `⏹ Stop & Log Session`, callback_data: `timer_stop:${now}:${sessionEpoch}` }],
          ];

          await sendTripleChimeAlert(
            timer.chat_id,
            "⏰ <b>BEEP!</b> (Break Ending 1/3)",
            "⏰ <b>BEEP!</b> (Get Ready! 2/3)",
            `🚨 ⏰ 🔔 <b>BEEP BEEP! Break is Over!</b> 🔔 ⏰ 🚨\n\n` +
              `You finished <b>${workMins}m focus + ${breakMins}m break</b>.\n` +
              `Ready for <b>Round ${nextRound}</b>?`,
            nextKb
          );

          pomodoroInfo = {
            ...pomodoroInfo,
            round: nextRound,
            phase: "work",
            phaseStartedAtIso: new Date(now).toISOString(),
          };

          if (messageId) {
            const updatedView = buildTimerView(
              timer.task_name,
              timer.started_at,
              now,
              newPausedSeconds,
              timer.project_name,
              null,
              timer.todo_title,
              pomodoroInfo
            );
            await editTelegramMessage(timer.chat_id, messageId, updatedView.text, updatedView.keyboard);
          }
          continue;
        }
      }
    }

    // 1) Keep the live timer view fresh
    if (messageId) {
      const view = buildTimerView(
        timer.task_name,
        timer.started_at,
        pause.pausedAt ?? 0,
        pause.pausedSeconds,
        timer.project_name,
        null,
        timer.todo_title,
        pomodoroInfo
      );
      await editTelegramMessage(timer.chat_id, messageId, view.text, view.keyboard);
    }

    // 2) 5-minute milestone buzz / nudge (never while paused, never for Sleep, never during Pomodoro break).
    if (/sleep/i.test(timer.task_name)) continue;
    if (pause.pausedAt) continue;
    if (timer.is_pomodoro && (timer.pomodoro_phase === "break" || timer.pomodoro_phase === "awaiting_break")) continue;

    const nudge = await getNudgeState(timer.chat_id);
    const nextNudgeAt = nudge.nextNudgeAt || new Date(timer.started_at).getTime() + NUDGE_INTERVAL_MS;
    if (now < nextNudgeAt) continue;

    // Replace the previous nudge so only one is ever visible
    if (nudge.messageId) {
      await deleteTelegramMessage(timer.chat_id, nudge.messageId);
    }

    let nudgeText = "";
    if (timer.is_pomodoro) {
      const phaseStartMs = new Date(timer.phase_started_at || timer.started_at).getTime();
      const phaseElapsedSec = Math.max(0, Math.floor((now - phaseStartMs) / 1000));
      const targetWorkSec = (timer.pomodoro_work_mins || 25) * 60;
      const remainingSec = Math.max(0, targetWorkSec - phaseElapsedSec);
      const round = timer.pomodoro_round || 1;
      nudgeText =
        `🍅 <b>${timer.task_name}</b> (Round ${round})\n` +
        `⏱️ <b>${formatDuration(phaseElapsedSec)}</b> elapsed — <b>${formatDuration(remainingSec)}</b> remaining in this focus round.`;
    } else {
      const elapsedSeconds = Math.max(
        0,
        Math.floor((now - new Date(timer.started_at).getTime()) / 1000) - pause.pausedSeconds
      );
      nudgeText = `⏱️ <b>${timer.task_name}</b> is still running — <b>${formatDuration(elapsedSeconds)}</b> elapsed.`;
    }

    const sent = await sendTelegramMessage(timer.chat_id, nudgeText);

    await setNudgeState(timer.chat_id, {
      messageId: sent?.result?.message_id ?? null,
      nextNudgeAt: now + NUDGE_INTERVAL_MS,
    });
  }
}

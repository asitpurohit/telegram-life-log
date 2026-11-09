import { NextRequest, NextResponse } from "next/server";
import {
  getActiveTimer,
  getPauseState,
  setPauseState,
  clearPauseState,
  updateActiveTimer,
  stopActiveTimer,
  getTimerMessage,
  getTimerProjectProgress,
  getNudgeState,
  setNudgeState,
  clearNudgeState,
  clearSleepAlarmState,
  findTaskByName,
  getTodayTaskTotal,
  updateUserSettings,
  finalizeIdleSnooze,
  updateLogFocus,
  saveWizardSession,
  getSavedAppUrl,
  isSystemTask,
} from "@/lib/supabase";
import { clearIdleAlertCard } from "@/lib/idleGuardian";
import {
  editTelegramMessage,
  sendTelegramMessage,
  deleteTelegramMessage,
  InlineKeyboard,
} from "@/lib/telegram";
import {
  buildTimerView,
  extractPomodoroInfo,
  formatDuration,
  PomodoroInfo,
  NUDGE_INTERVAL_MS,
} from "@/lib/timerRuntime";
import {
  buildCheckoutViewText,
  buildCheckoutKeyboard,
  formatSplitSummary,
} from "@/lib/checkoutView";
import { formatTimerMinutes } from "@/lib/timeAudit";
import { WizardSession } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const chatId = body.chatId ? String(body.chatId) : null;
    const action = body.action as string;

    if (!chatId || !action) {
      return NextResponse.json(
        { ok: false, error: "Missing chatId or action" },
        { status: 400 }
      );
    }

    const [active, prevTimerId, pause] = await Promise.all([
      getActiveTimer(chatId),
      getTimerMessage(chatId),
      getPauseState(chatId),
    ]);

    if (!active && action !== "stop") {
      return NextResponse.json(
        { ok: false, error: "No active timer is running" },
        { status: 404 }
      );
    }

    const appUrl = await getSavedAppUrl();
    const webAppUrl = appUrl ? `${appUrl}/timer?chatId=${chatId}` : null;

    // --- PAUSE ---
    if (action === "pause") {
      if (!active) {
        return NextResponse.json({ ok: false, error: "No timer running" }, { status: 404 });
      }

      const pausedAt = pause.pausedAt ?? Date.now();
      const [progressStr] = await Promise.all([
        getTimerProjectProgress(active.project_id),
        setPauseState(chatId, { pausedAt, pausedSeconds: pause.pausedSeconds }),
        clearIdleAlertCard(chatId, prevTimerId || undefined),
        getNudgeState(chatId).then(async (nudge) => {
          if (nudge.messageId) {
            await deleteTelegramMessage(chatId, nudge.messageId);
          }
          await clearNudgeState(chatId);
        }),
      ]);

      const pomodoroInfo = extractPomodoroInfo(active);
      const view = buildTimerView(
        active.task_name,
        active.started_at,
        pausedAt,
        pause.pausedSeconds,
        active.project_name,
        progressStr,
        active.todo_title,
        pomodoroInfo,
        null,
        webAppUrl
      );

      if (prevTimerId) {
        void editTelegramMessage(chatId, prevTimerId, view.text, view.keyboard);
      }

      return NextResponse.json({
        ok: true,
        action: "pause",
        active: {
          isPaused: true,
          pausedAt,
          pausedSeconds: pause.pausedSeconds,
        },
      });
    }

    // --- RESUME ---
    if (action === "resume") {
      if (!active) {
        return NextResponse.json({ ok: false, error: "No timer running" }, { status: 404 });
      }

      const pausedAt = pause.pausedAt ?? 0;
      let pausedSeconds = pause.pausedSeconds;
      let pauseDurationMs = 0;
      if (pausedAt > 0) {
        pauseDurationMs = Math.max(0, Date.now() - pausedAt);
        pausedSeconds += Math.round(pauseDurationMs / 1000);
      }

      let newPhaseStartedAtIso: string | undefined;
      if (
        active.is_pomodoro &&
        active.pomodoro_phase === "work" &&
        pauseDurationMs > 0 &&
        active.phase_started_at
      ) {
        const newPhaseStartMs = new Date(active.phase_started_at).getTime() + pauseDurationMs;
        newPhaseStartedAtIso = new Date(newPhaseStartMs).toISOString();
        active.phase_started_at = newPhaseStartedAtIso;
      }

      const [progressStr] = await Promise.all([
        getTimerProjectProgress(active.project_id),
        setPauseState(chatId, { pausedAt: null, pausedSeconds }),
        newPhaseStartedAtIso
          ? updateActiveTimer(chatId, { phase_started_at: newPhaseStartedAtIso })
          : Promise.resolve(),
        clearIdleAlertCard(chatId, prevTimerId || undefined),
        finalizeIdleSnooze(chatId),
        updateUserSettings(chatId, { idle_snoozed_until: null }),
        getNudgeState(chatId).then(async (nudge) => {
          if (nudge.messageId) {
            await deleteTelegramMessage(chatId, nudge.messageId);
          }
          await setNudgeState(chatId, {
            messageId: null,
            nextNudgeAt: Date.now() + NUDGE_INTERVAL_MS,
          });
        }),
      ]);

      const pomodoroInfo = extractPomodoroInfo(active);
      const view = buildTimerView(
        active.task_name,
        active.started_at,
        0,
        pausedSeconds,
        active.project_name,
        progressStr,
        active.todo_title,
        pomodoroInfo,
        null,
        webAppUrl
      );

      if (prevTimerId) {
        void editTelegramMessage(chatId, prevTimerId, view.text, view.keyboard);
      }

      return NextResponse.json({
        ok: true,
        action: "resume",
        active: {
          isPaused: false,
          pausedAt: null,
          pausedSeconds,
          phaseStartedAt: newPhaseStartedAtIso || active.phase_started_at,
        },
      });
    }

    // --- STOP ---
    if (action === "stop") {
      const endMs = pause.pausedAt ?? 0;
      const result = await stopActiveTimer(
        chatId,
        endMs > 0 ? endMs : undefined,
        pause.pausedSeconds
      );

      if (!result) {
        await Promise.all([
          clearPauseState(chatId),
          clearNudgeState(chatId),
          clearIdleAlertCard(chatId, prevTimerId || undefined),
          clearSleepAlarmState(chatId),
        ]);
        return NextResponse.json({ ok: true, stopped: true, durationSeconds: 0 });
      }

      const [task, totalToday] = await Promise.all([
        findTaskByName(result.taskName),
        getTodayTaskTotal(result.taskName),
        clearPauseState(chatId),
        clearIdleAlertCard(chatId, prevTimerId || undefined),
        clearSleepAlarmState(chatId),
        getNudgeState(chatId).then(async (nudge) => {
          if (nudge.messageId) {
            await deleteTelegramMessage(chatId, nudge.messageId);
          }
          await clearNudgeState(chatId);
        }),
      ]);

      const target = task?.target_value || 60;
      const percent = Math.round((totalToday / target) * 100);
      const showReview =
        !!result.logId &&
        (result.durationSeconds >= 300 || !!result.projectId || !!result.todoId) &&
        !isSystemTask(task);

      if (showReview && result.logId) {
        await updateLogFocus(result.logId, "casual");

        const taskData: WizardSession["task_data"] = {
          sessionLogId: result.logId,
          promptMessageId: prevTimerId || undefined,
          projectId: result.projectId || undefined,
          projectName: result.projectName || undefined,
          todoId: result.todoId || undefined,
          todoTitle: result.todoTitle || undefined,
          taskName: result.taskName,
          focus: "casual",
          todoStatus: "in_progress",
          projectStatus: "in_progress",
          durationSeconds: result.durationSeconds,
          totalToday,
          target,
          percent,
          splitStr: formatSplitSummary(result.split),
        };

        await saveWizardSession(chatId, "checkout_review", taskData);

        const text = buildCheckoutViewText(taskData);
        const stopKb = buildCheckoutKeyboard(taskData);

        if (prevTimerId) {
          await editTelegramMessage(chatId, prevTimerId, text, stopKb);
        } else {
          await sendTelegramMessage(chatId, text, stopKb);
        }
      } else {
        const projectLine = result.projectName ? `📦 Project: <b>${result.projectName}</b>\n` : "";
        const todoLine = result.todoTitle ? `🎯 Task: <b>${result.todoTitle}</b>\n` : "";
        const text =
          `🎉 <b>${result.taskName} Session Completed!</b>\n\n` +
          projectLine +
          todoLine +
          `⏱️ This Session: <b>${formatDuration(result.durationSeconds)}</b>\n` +
          `📊 Today's Total: <b>${formatTimerMinutes(totalToday)} / ${formatTimerMinutes(target)}</b> (${percent}% of daily goal)\n\n` +
          `Saved to your log!` +
          formatSplitSummary(result.split);

        const stopKb: InlineKeyboard = [
          [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
        ];

        if (prevTimerId) {
          await editTelegramMessage(chatId, prevTimerId, text, stopKb);
        } else {
          await sendTelegramMessage(chatId, text, stopKb);
        }
      }

      return NextResponse.json({
        ok: true,
        action: "stop",
        stopped: true,
        durationSeconds: result.durationSeconds,
        taskName: result.taskName,
        totalToday,
      });
    }

    // --- POMODORO: START BREAK ---
    if (action === "pomodoro_start_break" && active) {
      const now = Date.now();
      let newPausedSeconds = pause.pausedSeconds;
      if (pause.pausedAt && pause.pausedAt > 0) {
        const waitSec = Math.max(0, Math.floor((now - pause.pausedAt) / 1000));
        newPausedSeconds += waitSec;
      }

      const nowIso = new Date(now).toISOString();
      const [progressStr] = await Promise.all([
        getTimerProjectProgress(active.project_id),
        setPauseState(chatId, { pausedAt: now, pausedSeconds: newPausedSeconds }),
        updateActiveTimer(chatId, {
          pomodoro_phase: "break",
          phase_started_at: nowIso,
        }),
        clearIdleAlertCard(chatId, prevTimerId || undefined),
        finalizeIdleSnooze(chatId),
        updateUserSettings(chatId, { idle_snoozed_until: null }),
      ]);

      const pomodoroInfo: PomodoroInfo = {
        isPomodoro: true,
        workMins: active.pomodoro_work_mins || 25,
        breakMins: active.pomodoro_break_mins || 5,
        round: active.pomodoro_round || 1,
        phase: "break",
        phaseStartedAtIso: nowIso,
      };

      const view = buildTimerView(
        active.task_name,
        active.started_at,
        now,
        newPausedSeconds,
        active.project_name,
        progressStr,
        active.todo_title,
        pomodoroInfo,
        null,
        webAppUrl
      );

      if (prevTimerId) {
        void editTelegramMessage(chatId, prevTimerId, view.text, view.keyboard);
      }

      return NextResponse.json({
        ok: true,
        action: "pomodoro_start_break",
        active: {
          phase: "break",
          phaseStartedAt: nowIso,
          round: active.pomodoro_round || 1,
          isPaused: true,
        },
      });
    }

    // --- POMODORO: SKIP BREAK ---
    if (action === "pomodoro_skip_break" && active) {
      const now = Date.now();
      let newPausedSeconds = pause.pausedSeconds;
      if (pause.pausedAt && pause.pausedAt > 0) {
        const waitSec = Math.max(0, Math.floor((now - pause.pausedAt) / 1000));
        newPausedSeconds += waitSec;
      }

      const nextRound = (active.pomodoro_round || 1) + 1;
      const nowIso = new Date(now).toISOString();

      const [progressStr] = await Promise.all([
        getTimerProjectProgress(active.project_id),
        setPauseState(chatId, { pausedAt: null, pausedSeconds: newPausedSeconds }),
        updateActiveTimer(chatId, {
          pomodoro_phase: "work",
          pomodoro_round: nextRound,
          phase_started_at: nowIso,
        }),
        clearIdleAlertCard(chatId, prevTimerId || undefined),
        finalizeIdleSnooze(chatId),
        updateUserSettings(chatId, { idle_snoozed_until: null }),
      ]);

      const pomodoroInfo: PomodoroInfo = {
        isPomodoro: true,
        workMins: active.pomodoro_work_mins || 25,
        breakMins: active.pomodoro_break_mins || 5,
        round: nextRound,
        phase: "work",
        phaseStartedAtIso: nowIso,
      };

      const view = buildTimerView(
        active.task_name,
        active.started_at,
        0,
        newPausedSeconds,
        active.project_name,
        progressStr,
        active.todo_title,
        pomodoroInfo,
        null,
        webAppUrl
      );

      if (prevTimerId) {
        void editTelegramMessage(chatId, prevTimerId, view.text, view.keyboard);
      }

      return NextResponse.json({
        ok: true,
        action: "pomodoro_skip_break",
        active: {
          phase: "work",
          phaseStartedAt: nowIso,
          round: nextRound,
          isPaused: false,
        },
      });
    }

    // --- POMODORO: NEXT ROUND ---
    if (action === "pomodoro_next_round" && active) {
      const now = Date.now();
      let newPausedSeconds = pause.pausedSeconds;
      if (pause.pausedAt && pause.pausedAt > 0) {
        const waitSec = Math.max(0, Math.floor((now - pause.pausedAt) / 1000));
        newPausedSeconds += waitSec;
      }

      const nowIso = new Date(now).toISOString();
      const [progressStr] = await Promise.all([
        getTimerProjectProgress(active.project_id),
        setPauseState(chatId, { pausedAt: null, pausedSeconds: newPausedSeconds }),
        updateActiveTimer(chatId, {
          pomodoro_phase: "work",
          phase_started_at: nowIso,
        }),
        clearIdleAlertCard(chatId, prevTimerId || undefined),
        finalizeIdleSnooze(chatId),
        updateUserSettings(chatId, { idle_snoozed_until: null }),
      ]);

      const pomodoroInfo: PomodoroInfo = {
        isPomodoro: true,
        workMins: active.pomodoro_work_mins || 25,
        breakMins: active.pomodoro_break_mins || 5,
        round: active.pomodoro_round || 1,
        phase: "work",
        phaseStartedAtIso: nowIso,
      };

      const view = buildTimerView(
        active.task_name,
        active.started_at,
        0,
        newPausedSeconds,
        active.project_name,
        progressStr,
        active.todo_title,
        pomodoroInfo,
        null,
        webAppUrl
      );

      if (prevTimerId) {
        void editTelegramMessage(chatId, prevTimerId, view.text, view.keyboard);
      }

      return NextResponse.json({
        ok: true,
        action: "pomodoro_next_round",
        active: {
          phase: "work",
          phaseStartedAt: nowIso,
          round: active.pomodoro_round || 1,
          isPaused: false,
        },
      });
    }

    return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    console.error("Error in /api/timer/action:", err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import {
  sendTelegramMessage,
  editTelegramMessage,
  answerCallbackQuery,
  removeInlineKeyboard,
  deleteTelegramMessage,
  setBotCommands,
  BOT_COMMANDS,
  InlineKeyboard,
} from "@/lib/telegram";
import {
  getActiveTasks,
  getTaskById,
  findTaskByName,
  taskNameExists,
  createTask,
  updateTask,
  archiveTask,
  startActiveTimer,
  getActiveTimer,
  getActiveProjectForTask,
  createProject,
  markProjectCompleted,
  getProjectById,
  getProjectTotalMinutes,
  getDailyTodosForProject,
  getDailyTodosForTask,
  getUnfinishedPastTodosForProject,
  getUnfinishedPastTodosForTask,
  carryOverTodosToToday,
  dismissPastTodos,
  getPendingTodosForProject,
  markProjectTodosDone,
  archiveProjectTodos,
  transferTodosToProject,
  addProjectTodo,
  setProjectTodoDone,
  getProjectTodoById,
  getLogById,
  getPauseState,
  setPauseState,
  clearPauseState,
  getNudgeState,
  setNudgeState,
  clearNudgeState,
  stopActiveTimer,
  logActivity,
  getTodayTaskTotal,
  getTodayLogs,
  getLogsInRange,
  getWizardSession,
  saveWizardSession,
  clearWizardSession,
  trackUiMessage,
  getTrackedUiMessage,
  trackTimerMessage,
  getTimerMessage,
  setActiveTask,
  getActiveTaskId,
  isTaskCompletedToday,
  isSystemTask,
  taskEmoji,
  untickTaskToday,
  deduplicateTodayTickLogs,
  getTaskSchedule,
  formatScheduleDisplay,
  isTaskScheduledForToday,
  updateDiaryMood,
  formatMoodDisplay,
  updateLogFocus,
  updateLogSessionNote,
  getTodayTaskFocus,
  createTodo,
  getTodos,
  getTodoById,
  setTodoDone,
  deleteTodo,
  getDoubts,
  getDoubtTopics,
  getTasksWithDoubts,
  getDoubtById,
  toggleDoubtStatus,
  deleteDoubt,
  findMatchingTopic,
  extractDoubtTopic,
  extractDoubtQuestion,
  updateActiveTimer,
  getUserSettings,
  updateUserSettings,
  setUserSummaryEmail,
} from "@/lib/supabase";
import { parseUserMessageWithAI, isQuickGibberishCheck, AIParsedIntent } from "@/lib/ai";
import { askAboutData } from "@/lib/analytics";
import { buildTimerView, formatDuration, NUDGE_INTERVAL_MS, PomodoroInfo } from "@/lib/timerRuntime";
import { computeWastedDays, formatTimerMinutes, shiftDateString } from "@/lib/timeAudit";
import { localDateLabel, localTimeString, localDateString, localDateShort, localWeekday, zonedDateTimeToUtc, todoDueLabel } from "@/lib/time";
import { TaskType, Task, WizardSession, Todo, ProjectTodo, ActiveTimer, UserSettings } from "@/lib/types";
import { buildTodayScorecard, formatReminderTime, formatGoalDisplay, formatFocusBadge } from "@/lib/scorecard";
import { sendDailySummaryEmail } from "@/lib/dailyEmailSummary";

export const dynamic = "force-dynamic";

// =========================================================================
// WIZARD PROMPT TRACKING
// Old Telegram prompts keep their inline buttons forever, so every wizard
// prompt stores its message id: stale taps are rejected and the previous
// prompt's keyboard is removed as soon as the flow advances.
// =========================================================================

function isTimerCallback(data: string): boolean {
  return (
    data === "timer_pause" ||
    data.startsWith("timer_pause:") ||
    data === "stop_active_timer" ||
    data.startsWith("timer_resume:") ||
    data.startsWith("timer_refresh:") ||
    data.startsWith("timer_stop:") ||
    data === "pomodoro_start_break" ||
    data === "pomodoro_skip_break" ||
    data === "pomodoro_next_round"
  );
}

function isWizardCallback(data: string): boolean {
  return (
    data === "wizard_cancel" ||
    data.startsWith("wizard_type:") ||
    data.startsWith("wizard_timer_target:") ||
    data.startsWith("wizard_count_target:") ||
    data.startsWith("wizard_skip:") ||
    data.startsWith("wizard_days:") ||
    data.startsWith("timer_custom_prompt:") ||
    data.startsWith("edit_clear_reminder:") ||
    data.startsWith("edit_set_days:") ||
    data.startsWith("todo_add:") ||
    data.startsWith("todo_date:") ||
    data.startsWith("todo_time:") ||
    data.startsWith("daily_todo_") ||
    data.startsWith("pick_todo") ||
    data.startsWith("todo_fin:")
  );
}

async function sendWizardPrompt(
  chatId: string | number,
  step: WizardSession["step"],
  taskData: WizardSession["task_data"],
  text: string,
  keyboard?: InlineKeyboard,
  editMessageId?: number
): Promise<void> {
  let promptMessageId: number | undefined;

  if (editMessageId) {
    await editTelegramMessage(chatId, editMessageId, text, keyboard);
    promptMessageId = editMessageId;
  } else {
    const res = await sendTelegramMessage(chatId, text, keyboard);
    promptMessageId = res?.result?.message_id;
  }

  const previousPromptId = taskData.promptMessageId;
  if (previousPromptId && previousPromptId !== promptMessageId) {
    await removeInlineKeyboard(chatId, previousPromptId);
  }

  // Retire whatever menu was previously the active surface for this chat
  await retireTrackedUi(chatId, promptMessageId);

  if (promptMessageId) {
    await trackUiMessage(chatId, promptMessageId);
  }

  await saveWizardSession(chatId, step, { ...taskData, promptMessageId });
}

async function retireTrackedUi(chatId: string | number, keepMessageId?: number): Promise<void> {
  const trackedId = await getTrackedUiMessage(chatId);
  if (trackedId && trackedId !== keepMessageId) {
    await removeInlineKeyboard(chatId, trackedId);
  }
}

async function sendUiMessage(
  chatId: string | number,
  text: string,
  keyboard?: InlineKeyboard
): Promise<number | undefined> {
  const res = await sendTelegramMessage(chatId, text, keyboard);
  const newMessageId = res?.result?.message_id;
  await retireTrackedUi(chatId, newMessageId);
  if (newMessageId) {
    await trackUiMessage(chatId, newMessageId);
  }
  return newMessageId;
}

async function editUiMessage(
  chatId: string | number,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard
): Promise<void> {
  await editTelegramMessage(chatId, messageId, text, keyboard ?? []);
  await retireTrackedUi(chatId, messageId);
  await trackUiMessage(chatId, messageId);
}

// Reply by editing the tapped message (when possible) and keep only one active keyboard
async function respondUi(
  chatId: string | number,
  messageId: number | undefined,
  text: string,
  keyboard?: InlineKeyboard
): Promise<void> {
  if (messageId) {
    await editUiMessage(chatId, messageId, text, keyboard);
  } else {
    await sendUiMessage(chatId, text, keyboard);
  }
}

async function clearWizardSessionAndRetirePrompt(chatId: string | number): Promise<void> {
  const session = await getWizardSession(chatId);
  const promptId = session?.task_data?.promptMessageId;
  await clearWizardSession(chatId);
  if (promptId) {
    await removeInlineKeyboard(chatId, promptId);
  }
  await retireTrackedUi(chatId, promptId);
}

// =========================================================================
// HELPER FUNCTIONS (Parsing & Formatting)
// =========================================================================

// Parse natural time input (e.g. "8am", "08:00 AM", "18:30", "8:30 pm") to "HH:MM:SS"
function parseReminderTime(input: string): string | null {
  const clean = input.trim().toLowerCase();

  // 12-hour format: "8am", "8:30am", "8:30 am", "8 pm", "12pm", "12am"
  const regex12 = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/;
  const m12 = clean.match(regex12);
  if (m12) {
    let hours = parseInt(m12[1], 10);
    const minutes = m12[2] ? parseInt(m12[2], 10) : 0;
    const isPm = m12[3] === "pm";
    if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) return null;
    if (hours === 12) {
      hours = isPm ? 12 : 0;
    } else if (isPm) {
      hours += 12;
    }
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;
  }

  // 24-hour format: "08:00", "18:30", "23:45"
  const regex24 = /^(\d{1,2}):(\d{2})$/;
  const m24 = clean.match(regex24);
  if (m24) {
    const hours = parseInt(m24[1], 10);
    const minutes = parseInt(m24[2], 10);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;
    }
  }

  // Bare number: "8", "20"
  const regexBare = /^(\d{1,2})$/;
  const mBare = clean.match(regexBare);
  if (mBare) {
    const hours = parseInt(mBare[1], 10);
    if (hours >= 0 && hours <= 23) {
      return `${String(hours).padStart(2, "0")}:00:00`;
    }
  }

  return null;
}

// Parse timer goals in hours and minutes: e.g. "2 hours", "1h 30m", "45 mins", "90"
function parseTimerGoal(input: string): number | null {
  const clean = input.trim().toLowerCase();

  // Pattern 1: e.g. "1 hour 30 mins", "2h 30m", "1 hr 45 min", "2 hours 15 minutes"
  const regexHrMin = /^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\s*(?:and\s*)?(\d+)?\s*(?:m|min|mins|minute|minutes)?$/;
  const mHrMin = clean.match(regexHrMin);
  if (mHrMin) {
    const hours = parseFloat(mHrMin[1]);
    const minutes = mHrMin[2] ? parseInt(mHrMin[2], 10) : 0;
    return Math.round(hours * 60 + minutes);
  }

  // Pattern 2: e.g. "45m", "45 mins", "90 minutes"
  const regexMin = /^(\d+)\s*(?:m|min|mins|minute|minutes)$/;
  const mMin = clean.match(regexMin);
  if (mMin) {
    return parseInt(mMin[1], 10);
  }

  // Pattern 3: e.g. "1.5h", "2 hours"
  const regexHr = /^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)$/;
  const mHr = clean.match(regexHr);
  if (mHr) {
    return Math.round(parseFloat(mHr[1]) * 60);
  }

  // Pattern 4: Bare number like "60", "90", "120"
  const regexBare = /^(\d+)$/;
  const mBare = clean.match(regexBare);
  if (mBare) {
    return parseInt(mBare[1], 10);
  }

  return null;
}

// Parse counter goals (amount + unit, e.g. "10 km", "5000 ml", "3 liters", "50 pages", "10000 steps")
function parseCountGoalAndUnit(input: string): { value: number; unit: string } | null {
  const clean = input.trim();
  const match = clean.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  if (isNaN(num) || num <= 0) return null;
  const rawUnit = match[2]?.toLowerCase() || "units";

  if (rawUnit === "liter" || rawUnit === "liters" || rawUnit === "l") {
    return { value: Math.round(num * 1000), unit: "ml" };
  }
  return { value: Math.round(num), unit: rawUnit };
}

// Signed variants used ONLY for typed corrections with an open task.
// Creation/edit goals keep using the positive-only parsers above.
function parseSignedTimerAmount(input: string): number | null {
  const clean = input.trim();
  const negative = clean.startsWith("-");
  const mins = parseTimerGoal(negative ? clean.slice(1).trim() : clean);
  if (mins === null || mins === 0) return null;
  return negative ? -mins : mins;
}

function parseSignedCountAmount(input: string): number | null {
  const clean = input.trim();
  const negative = clean.startsWith("-");
  const parsed = parseCountGoalAndUnit(negative ? clean.slice(1).trim() : clean);
  if (!parsed || parsed.value === 0) return null;
  return negative ? -parsed.value : parsed.value;
}

function formatProjectProgress(totalMinutes: number, targetMinutes?: number | null): string {
  if (!targetMinutes || targetMinutes <= 0) {
    return formatTimerMinutes(totalMinutes);
  }
  const percent = Math.round((totalMinutes / targetMinutes) * 100);
  return `${formatTimerMinutes(totalMinutes)} / ${formatTimerMinutes(targetMinutes)} (${percent}%)`;
}

async function getTimerProjectProgress(projectId?: string | null): Promise<string | null> {
  if (!projectId) return null;
  const project = await getProjectById(projectId);
  if (!project) return null;
  const totalMins = await getProjectTotalMinutes(projectId);
  return formatProjectProgress(totalMins, project.target_minutes);
}

// Task detail view (used by /tasks and as the reply target for typed amounts)
async function buildTaskDetail(task: Task): Promise<{ text: string; keyboard: InlineKeyboard }> {
  if (task.type === "timer") {
    const todayMins = await getTodayTaskTotal(task.name);
    const target = task.target_value || 60;
    const percent = Math.min(100, Math.round((todayMins / target) * 100));
    const activeProject = task.is_project_based ? await getActiveProjectForTask(task.id) : null;
    let projectLine = "";
    if (task.is_project_based) {
      if (activeProject) {
        const totalProjMins = await getProjectTotalMinutes(activeProject.id);
        const progressStr = formatProjectProgress(totalProjMins, activeProject.target_minutes);
        projectLine =
          `📦 Active Project: <b>${activeProject.name}</b>\n` +
          `📊 Project Total: <b>${progressStr}</b>\n` +
          (activeProject.description ? `📝 Scope: <i>${activeProject.description}</i>\n` : "");
      } else {
        projectLine = `📦 Project Mode: <b>ON</b> <i>(No active project)</i>\n`;
      }
    }
    const today = localDateString();
    const dailyTodos = activeProject
      ? await getDailyTodosForProject(activeProject.id, today)
      : await getDailyTodosForTask(task.id, today);

    let todosLine = "";
    if (dailyTodos.length > 0) {
      const completedCount = dailyTodos.filter((t) => t.is_done).length;
      todosLine = `\n📋 Today's Tasks: <b>${completedCount}/${dailyTodos.length} done</b>\n`;
      for (const td of dailyTodos) {
        todosLine += `  ${td.is_done ? "✅" : "▫️"} ${td.title}\n`;
      }
    }

    const pomodoroLine = task.is_pomodoro
      ? `\n🍅 Pomodoro: <b>${task.pomodoro_work_mins || 25}m focus / ${task.pomodoro_break_mins || 5}m break</b>`
      : "";

    return {
      text:
        `${taskEmoji(task)} <b>${task.name}</b>\n` +
        `🎯 Daily Goal: <b>${formatGoalDisplay(target, "minutes")}</b>\n` +
        `📅 Schedule: <b>${formatScheduleDisplay(getTaskSchedule(task))}</b>\n` +
        projectLine +
        pomodoroLine +
        `\n📊 Today's Progress: <b>${formatTimerMinutes(todayMins)} / ${formatTimerMinutes(target)}</b> (${percent}%)\n` +
        todosLine +
        `\nStart the stopwatch, or just type the minutes to log (e.g. <b>45</b>):`,
      keyboard: [
        [{ text: task.is_pomodoro ? `🍅 Start Pomodoro (${task.pomodoro_work_mins || 25}m/${task.pomodoro_break_mins || 5}m)` : `▶️ Start Live Stopwatch`, callback_data: `start_task:${task.id}` }],
        ...(!task.is_system ? [[{ text: "❓ View Doubts", callback_data: `doubt_topics:${task.id}` }]] : []),
        [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
      ],
    };
  }

  if (task.type === "counter") {
    const todayTotal = await getTodayTaskTotal(task.name);
    const target = task.target_value || 5000;
    const percent = Math.min(100, Math.round((todayTotal / target) * 100));
    const unit = task.unit || "units";
    return {
      text:
        `💧 <b>${task.name}</b>\n` +
        `🎯 Goal: <b>${formatGoalDisplay(target, unit)}</b>\n` +
        `📅 Schedule: <b>${formatScheduleDisplay(getTaskSchedule(task))}</b>\n` +
        `📊 Today: <b>${todayTotal.toLocaleString()} / ${formatGoalDisplay(target, unit)}</b> (${percent}%)\n\n` +
        `Tap a button, or just type the amount to add (e.g. <b>250</b>):`,
      keyboard: [
        [
          { text: `+1 ${unit}`, callback_data: `counter_add:${task.id}:1` },
          { text: `+5 ${unit}`, callback_data: `counter_add:${task.id}:5` },
          { text: `+10 ${unit}`, callback_data: `counter_add:${task.id}:10` },
        ],
        [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
      ],
    };
  }

  const isDone = await isTaskCompletedToday(task.id);
  if (isDone) {
    return {
      text: `✅ <b>${task.name}</b> is marked complete for today!\nTap below if you want to undo:`,
      keyboard: [
        [{ text: `⭕ Mark Incomplete (Undo)`, callback_data: `untick_task:${task.id}` }],
        [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
      ],
    };
  }
  return {
    text: `📌 <b>${task.name}</b>\nSchedule: <b>${formatScheduleDisplay(getTaskSchedule(task))}</b>\nReady to mark complete:`,
    keyboard: [
      [{ text: `✅ Mark Done for Today`, callback_data: `tick_task:${task.id}` }],
      [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
    ],
  };
}

// Opens a task's detail screen. While another timer is running, opening a
// timer task is blocked with a stop-first warning shown in the tapped message.
async function openTaskScreen(
  chatId: string | number,
  messageId: number | undefined,
  task: Task,
  opts: { fresh: boolean }
): Promise<void> {
  if (task.type === "timer") {
    const running = await getActiveTimer(chatId);
    if (running) {
      const retryCallback = opts.fresh ? `open_task:${task.id}` : `select_task:${task.id}`;
      const warnKb: InlineKeyboard = [
        [{ text: `⏹ Stop ${running.task_name}`, callback_data: `stop_then_open:${task.id}` }],
        [{ text: `📂 Open ${task.name}`, callback_data: retryCallback }],
      ];
      await respondUi(
        chatId,
        messageId,
        `⚠️ <b>${running.task_name}</b> is already running.\n\n` +
          `Stop it first to open <b>${task.name}</b>:`,
        warnKb
      );
      return;
    }
  }

  await setActiveTask(chatId, task.id);
  const detail = await buildTaskDetail(task);

  if (opts.fresh) {
    // Reminder "Open Task": fresh message at the bottom, retire the reminder button
    await sendUiMessage(chatId, detail.text, detail.keyboard);
    if (messageId) {
      await removeInlineKeyboard(chatId, messageId);
    }
  } else {
    await respondUi(chatId, messageId, detail.text, detail.keyboard);
  }
}

async function buildSettingsView(chatId: string | number): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const settings = await getUserSettings(chatId);
  const now = Date.now();

  let snoozeStatus = "";
  if (settings.idle_snoozed_until) {
    const snoozeEnd = new Date(settings.idle_snoozed_until).getTime();
    if (now < snoozeEnd) {
      const remainingMins = Math.ceil((snoozeEnd - now) / 60000);
      snoozeStatus = `\n⏸️ <i>Snoozed for next ${remainingMins} minutes</i>\n`;
    }
  }

  const statusEmoji = settings.idle_nudge_enabled ? "🟢" : "⚪";
  const statusLabel = settings.idle_nudge_enabled ? "ON (Active)" : "OFF (Disabled)";

  const emailRecipient = settings.summary_email_to || process.env.SUMMARY_EMAIL_TO;
  const resendKey = process.env.RESEND_API_KEY;
  const smtpHost = process.env.SMTP_HOST;
  const emailProviderLabel = resendKey ? "Resend (Free)" : smtpHost ? "Gmail / SMTP" : "None";
  const emailConfigured = Boolean(emailRecipient && (resendKey || smtpHost));

  const text =
    `⚙️ <b>Settings & Preferences</b>\n\n` +
    `🛡️ <b>Anti-Slacking Idle Guardian:</b>\n` +
    `• Status: <b>${statusEmoji} ${statusLabel}</b>\n` +
    `• Active Window: <b>${settings.idle_window_start} – ${settings.idle_window_end}</b>\n` +
    `• Alert Interval: <b>Every ${settings.idle_interval_mins} minutes</b>\n` +
    snoozeStatus +
    `\n<i>When active and no timer is running during your active hours, the bot sends 4 quick beeps to keep you focused.</i>\n\n` +
    `📧 <b>Daily Summary Email:</b>\n` +
    `• Status: <b>${emailConfigured ? "🟢 Active" : "⚪ Not configured"}</b>\n` +
    `• Recipient: <code>${emailRecipient || "None (tap Change Email below)"}</code>\n` +
    `• Provider: <b>${emailProviderLabel}</b>`;

  const isDefaultWindow = settings.idle_window_start === "05:00" && settings.idle_window_end === "22:00";

  const keyboard: InlineKeyboard = [
    [
      {
        text: settings.idle_nudge_enabled ? "🔴 Turn OFF Idle Guard" : "🟢 Turn ON Idle Guard",
        callback_data: "toggle_idle_guardian",
      },
    ],
    [
      { text: `⏱️ 3m${settings.idle_interval_mins === 3 ? " ✓" : ""}`, callback_data: "set_idle_interval:3" },
      { text: `⏱️ 5m${settings.idle_interval_mins === 5 ? " ✓" : ""}`, callback_data: "set_idle_interval:5" },
      { text: `⏱️ 15m${settings.idle_interval_mins === 15 ? " ✓" : ""}`, callback_data: "set_idle_interval:15" },
      { text: `⏱️ 30m${settings.idle_interval_mins === 30 ? " ✓" : ""}`, callback_data: "set_idle_interval:30" },
    ],
    [
      {
        text: `⏰ Window: 5 AM – 10 PM${isDefaultWindow ? " ✓" : ""}`,
        callback_data: "set_idle_window:05:00:22:00",
      },
    ],
    [
      { text: "✏️ Custom Window", callback_data: "set_idle_window:custom" },
    ],
    [
      { text: "✏️ Custom Interval", callback_data: "set_idle_interval:custom" },
    ],
    [
      { text: "⏸ Snooze 30m", callback_data: "idle_snooze:30" },
      ...(settings.idle_snoozed_until ? [{ text: "▶️ Cancel Snooze", callback_data: "idle_unsnooze" }] : []),
    ],
    [
      { text: "✏️ Change Email", callback_data: "set_summary_email" },
    ],
    [
      { text: "📨 Send Email Now", callback_data: "send_test_email" },
    ],
    [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
  ];

  return { text, keyboard };
}

// One-line task summary used in edit/delete confirmations
function buildTaskSummary(task: Task): string {
  const typeIcon = taskEmoji(task);
  const projectLine =
    task.type === "timer" && !isSystemTask(task)
      ? `\n📦 Project-based: <b>${task.is_project_based ? "Yes" : "No"}</b>`
      : "";
  const pomodoroLine =
    task.type === "timer" && !isSystemTask(task)
      ? task.is_pomodoro
        ? `\n🍅 Pomodoro: <b>ON (${task.pomodoro_work_mins || 25}m focus / ${task.pomodoro_break_mins || 5}m break)</b>`
        : `\n🍅 Pomodoro: <b>OFF</b>`
      : "";
  return (
    `${typeIcon} <b>${task.name}</b>\n` +
    `🎯 Goal: <b>${formatGoalDisplay(task.target_value, task.unit)}</b>\n` +
    `⏰ Reminder: <b>${formatReminderTime(task.reminder_time)}</b>\n` +
    `📅 Days: <b>${formatScheduleDisplay(getTaskSchedule(task))}</b>` +
    projectLine +
    pomodoroLine
  );
}

function extractPomodoroInfo(active: ActiveTimer | null): PomodoroInfo | null {
  if (!active || !active.is_pomodoro) return null;
  return {
    isPomodoro: true,
    workMins: active.pomodoro_work_mins || 25,
    breakMins: active.pomodoro_break_mins || 5,
    round: active.pomodoro_round || 1,
    phase: (active.pomodoro_phase as "work" | "awaiting_break" | "break") || "work",
    phaseStartedAtIso: active.phase_started_at || active.started_at,
  };
}

// Start active timer with optional project and optional sub-task
async function doStartActiveTimer(
  chatId: string | number,
  messageId: number | undefined,
  taskId: string,
  taskName: string,
  projectId?: string | null,
  projectName?: string | null,
  todoId?: string | null,
  todoTitle?: string | null
): Promise<void> {
  const active = await startActiveTimer(chatId, taskId, taskName, projectId, projectName, todoId, todoTitle);
  await clearPauseState(chatId);
  await clearNudgeState(chatId);
  await setActiveTask(chatId, taskId);

  const startedAt = active?.started_at || new Date().toISOString();
  let progressStr: string | null = null;
  if (projectId) {
    progressStr = await getTimerProjectProgress(projectId);
  }
  const pomodoroInfo = extractPomodoroInfo(active);
  const view = buildTimerView(taskName, startedAt, 0, 0, projectName, progressStr, todoTitle, pomodoroInfo);
  if (messageId) {
    await respondUi(chatId, messageId, view.text, view.keyboard);
  } else {
    await sendUiMessage(chatId, view.text, view.keyboard);
  }

  const timerMsgId = messageId ?? (await getTrackedUiMessage(chatId));
  if (timerMsgId) {
    await trackTimerMessage(chatId, timerMsgId);
  }
}

// Display the session to-do picker for starting a stopwatch session
async function showSessionTodoPick(
  chatId: string | number,
  messageId: number | undefined,
  taskId: string,
  taskName: string,
  projectId?: string | null,
  projectName?: string | null,
  todos?: ProjectTodo[]
): Promise<void> {
  const today = localDateString();
  const allTodos =
    todos ||
    (projectId
      ? await getDailyTodosForProject(projectId, today)
      : await getDailyTodosForTask(taskId, today));

  const pendingTodos = allTodos.filter((t) => !t.is_done);
  const completedCount = allTodos.filter((t) => t.is_done).length;

  await saveWizardSession(chatId, "awaiting_session_todo_pick", {
    taskId,
    taskName,
    projectId: projectId || undefined,
    projectName: projectName || undefined,
    promptMessageId: messageId,
  });

  const buttons: InlineKeyboard = [];

  for (const todo of pendingTodos) {
    const label = todo.title.length > 28 ? todo.title.slice(0, 28) + "…" : todo.title;
    buttons.push([{ text: `📌 ${label}`, callback_data: `pick_todo:${todo.id}` }]);
  }

  buttons.push([
    { text: "➕ Add New Task", callback_data: "daily_todo_add_more" },
    { text: "⏩ General / None", callback_data: "pick_todo_none" },
  ]);
  buttons.push([{ text: "❌ Cancel", callback_data: `open_task:${taskId}` }]);

  const projectTag = projectName ? `📦 Project: <b>${projectName}</b>\n` : "";
  const completedNotice = completedCount > 0 ? ` <i>(${completedCount} completed today)</i>` : "";

  let promptText = `${projectTag}🎯 <b>Which task are you working on right now?</b>${completedNotice}\n\n`;
  if (pendingTodos.length > 0) {
    promptText += `Pick a task below, add a new one, or choose General:`;
  } else {
    promptText += `All of today's planned tasks are completed! 🎉\nAdd a new task or start with General:`;
  }

  if (messageId) {
    await respondUi(chatId, messageId, promptText, buttons);
  } else {
    await sendUiMessage(chatId, promptText, buttons);
  }
}

// Prompt for morning daily to-do list if none set today, or show to-do pick
async function promptOrStartTimer(
  chatId: string | number,
  messageId: number | undefined,
  taskId: string,
  taskName: string,
  projectId?: string | null,
  projectName?: string | null
): Promise<void> {
  const task = await getTaskById(taskId);
  if (isSystemTask(task)) {
    await doStartActiveTimer(chatId, messageId, taskId, taskName, null, null, null, null);
    return;
  }

  const today = localDateString();
  const existingTodos = projectId
    ? await getDailyTodosForProject(projectId, today)
    : await getDailyTodosForTask(taskId, today);

  if (existingTodos.length === 0) {
    // Check if there are unfinished tasks from previous sessions
    const pastTodos = projectId
      ? await getUnfinishedPastTodosForProject(projectId, today)
      : await getUnfinishedPastTodosForTask(taskId, today);

    if (pastTodos.length > 0) {
      await saveWizardSession(chatId, "awaiting_daily_todo_carryover", {
        taskId,
        taskName,
        projectId: projectId || undefined,
        projectName: projectName || undefined,
        promptMessageId: messageId,
        pastTodoIds: pastTodos.map((t) => t.id),
      });

      const projectTag = projectName ? `📦 Project: <b>${projectName}</b>\n\n` : "";
      const pastList = pastTodos.map((t, idx) => `${idx + 1}. ${t.title}`).join("\n");

      const kb: InlineKeyboard = [
        [{ text: `📥 Carry Over to Today (${pastTodos.length})`, callback_data: "carryover_apply" }],
        [{ text: "✨ Start Fresh / New Tasks", callback_data: "carryover_fresh" }],
        [{ text: "🗑️ Dismiss Past Tasks", callback_data: "carryover_dismiss" }],
        [{ text: "▶️ Start Timer (Leave Blank)", callback_data: "daily_todo_skip" }],
        [{ text: "❌ Cancel", callback_data: `open_task:${taskId}` }],
      ];

      const promptText =
        `${projectTag}⏳ <b>You have ${pastTodos.length} unfinished task${pastTodos.length > 1 ? "s" : ""} from previous sessions:</b>\n\n` +
        `${pastList}\n\n` +
        `Would you like to carry them over to today, or start fresh?`;

      if (messageId) {
        await respondUi(chatId, messageId, promptText, kb);
      } else {
        await sendUiMessage(chatId, promptText, kb);
      }
      return;
    }

    await saveWizardSession(chatId, "awaiting_daily_todo_input", {
      taskId,
      taskName,
      projectId: projectId || undefined,
      projectName: projectName || undefined,
      promptMessageId: messageId,
    });

    const projectTag = projectName ? `📦 Project: <b>${projectName}</b>\n\n` : "";
    const kb: InlineKeyboard = [
      [{ text: "▶️ Start Timer (Leave Blank)", callback_data: "daily_todo_skip" }],
      [{ text: "❌ Cancel", callback_data: `open_task:${taskId}` }],
    ];

    const promptText =
      `${projectTag}📋 <b>What tasks/work will you do today for ${projectName || taskName}?</b>\n\n` +
      `Send your tasks one by one or separated by commas:\n` +
      `<i>(e.g., "Read Snell's Law, Numericals 1-10, Formulas")</i>\n\n` +
      `Tap <b>Start Timer</b> below if you prefer to leave it blank:`;

    if (messageId) {
      await respondUi(chatId, messageId, promptText, kb);
    } else {
      await sendUiMessage(chatId, promptText, kb);
    }
    return;
  }

  await showSessionTodoPick(chatId, messageId, taskId, taskName, projectId, projectName, existingTodos);
}

// Focus buttons shown after positive task entries (timer stop, minutes, counts)
function buildFocusKeyboard(logId: string, selected?: string | null): InlineKeyboard {
  return [
    [
      { text: selected === "focused" ? "✅ 🎯 Focused" : "🎯 Focused", callback_data: `set_focus:${logId}:focused` },
      { text: selected === "casual" ? "✅ 😐 Casual" : "😐 Casual", callback_data: `set_focus:${logId}:casual` },
      { text: selected === "distracted" ? "✅ 😵 Distracted" : "😵 Distracted", callback_data: `set_focus:${logId}:distracted` },
    ],
  ];
}

const FOCUS_QUESTION = "\n\n<b>How was this session?</b>";

// Review-only keyboard: focus options + Back (no repeat/add/start buttons)
function buildReviewKeyboard(logId: string): InlineKeyboard {
  return [
    ...buildFocusKeyboard(logId),
    [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
  ];
}

const BACK_ONLY_KEYBOARD: InlineKeyboard = [
  [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
];

// Diary mentions become note-only rows on the matching tasks.
// value is always 0, so totals, counters and ticks are never affected.
async function attachDiarySubjects(
  ai: AIParsedIntent,
  tasks: Task[]
): Promise<{ task: string; detail: string }[]> {
  const merged = new Map<string, { name: string; details: string[] }>();

  for (const subject of ai.subjects || []) {
    const name = String(subject.task || "").trim();
    const detail = String(subject.detail || "").trim();
    if (!name || !detail) continue;

    const match = tasks.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!match) continue;

    const entry = merged.get(match.id) || { name: match.name, details: [] };
    entry.details.push(detail);
    merged.set(match.id, entry);
  }

  const attached: { task: string; detail: string }[] = [];
  for (const [taskId, entry] of merged.entries()) {
    const detailText = entry.details.join("; ");
    await logActivity({
      task_id: taskId,
      task_name: entry.name,
      value: 0,
      notes: `From diary: ${detailText}`,
    });
    attached.push({ task: entry.name, detail: detailText });
  }
  return attached;
}

// =========================================================================
// TODO HELPERS (one-time, date + time)
// =========================================================================

const TODO_MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

function buildTodoDate(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseTodoDate(input: string): string | null {
  const clean = input.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  const now = new Date();

  if (clean === "today") return localDateString(now);
  if (["tomorrow", "tmrw", "tmr"].includes(clean)) {
    return localDateString(new Date(now.getTime() + 86400000));
  }

  let m = clean.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return buildTodoDate(+m[1], +m[2], +m[3]);

  m = clean.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (m) {
    let y = m[3] ? +m[3] : now.getFullYear();
    if (y < 100) y += 2000;
    return buildTodoDate(y, +m[2], +m[1]);
  }

  m = clean.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{2,4}))?$/);
  if (m && TODO_MONTHS[m[2]]) {
    let y = m[3] ? +m[3] : now.getFullYear();
    if (y < 100) y += 2000;
    return buildTodoDate(y, TODO_MONTHS[m[2]], +m[1]);
  }

  m = clean.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{2,4}))?$/);
  if (m && TODO_MONTHS[m[1]]) {
    let y = m[3] ? +m[3] : now.getFullYear();
    if (y < 100) y += 2000;
    return buildTodoDate(y, TODO_MONTHS[m[1]], +m[2]);
  }

  return null;
}

function todoStatusIcon(todo: Todo): string {
  if (todo.is_done) return "✅";
  return new Date(todo.due_at).getTime() < Date.now() ? "⌛" : "🕐";
}

function buildTodoListText(todos: Todo[]): string {
  const pending = todos.filter((t) => !t.is_done);
  if (pending.length === 0) {
    return "📝 <b>Your To-Dos</b>\n\n<i>Nothing pending. Tap below to add one.</i>";
  }
  return (
    `📝 <b>Your To-Dos</b> — <b>${pending.length}</b>\n` +
    `<i>One-time reminders with a date & time.</i>`
  );
}

function buildTodoListKeyboard(todos: Todo[]): InlineKeyboard {
  const pending = todos.filter((t) => !t.is_done);

  const kb: InlineKeyboard = pending.map((t) => [
    {
      text: `${todoStatusIcon(t)} ${t.title.slice(0, 28)} — ${todoDueLabel(t.due_at)}`,
      callback_data: `todo_view:${t.id}`,
    },
  ]);
  kb.push([{ text: "➕ Add To-Do", callback_data: "todo_add:new" }]);
  return kb;
}

function buildTodoView(todo: Todo): { text: string; keyboard: InlineKeyboard } {
  const overdue = new Date(todo.due_at).getTime() < Date.now();
  const status = overdue ? "⌛ Overdue (not done)" : "🕐 Pending";

  const text =
    `📝 <b>${todo.title}</b>\n` +
    `🕐 Scheduled: <b>${todoDueLabel(todo.due_at)}</b>\n` +
    `🚦 Status: <b>${status}</b>`;

  const keyboard: InlineKeyboard = [
    [{ text: "✅ Mark Done", callback_data: `todo_done:${todo.id}` }],
    [{ text: "🗑️ Delete", callback_data: `todo_delete:${todo.id}` }],
    [{ text: "📋 All To-Dos", callback_data: "todo_list" }],
  ];

  return { text, keyboard };
}

function todoDatePrompt(title: string): string {
  return (
    `📅 <b>Which date?</b>\n\n` +
    `To-Do: <b>${title}</b>\n\n` +
    `Type a date:\n<i>(e.g., "today", "tomorrow", "25 Sep", "28/09", "2026-09-30")</i>\n\n` +
    `<b>— OR tap:</b>`
  );
}

function todoDateKb(): InlineKeyboard {
  return [
    [
      { text: "📅 Today", callback_data: "todo_date:today" },
      { text: "🌅 Tomorrow", callback_data: "todo_date:tomorrow" },
    ],
    [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
  ];
}

function todoTimePrompt(title: string, dateStr: string): string {
  return (
    `🕐 <b>What time?</b>\n\n` +
    `To-Do: <b>${title}</b>\n` +
    `Date: <b>${dateStr}</b>\n\n` +
    `Type a time:\n<i>(e.g., "8am", "2:30 pm", "18:30")</i>\n\n` +
    `<b>— OR tap:</b>`
  );
}

function todoTimeKb(): InlineKeyboard {
  return [
    [
      { text: "8:00 AM", callback_data: "todo_time:08:00" },
      { text: "12:00 PM", callback_data: "todo_time:12:00" },
    ],
    [
      { text: "6:00 PM", callback_data: "todo_time:18:00" },
      { text: "9:00 PM", callback_data: "todo_time:21:00" },
    ],
    [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
  ];
}

// =========================================================================
// DOUBT UI HELPERS
// =========================================================================

function buildDoubtMenuText(): string {
  return (
    `❓ <b>Doubt Log & Study Tracker</b>\n\n` +
    `Record and review your study questions, conceptual doubts, and coding blockers.\n\n` +
    `What would you like to do?`
  );
}

function buildDoubtMenuKeyboard(): InlineKeyboard {
  return [
    [{ text: "➕ Log New Doubt", callback_data: "doubt_menu:log" }],
    [{ text: "👁️ View Doubts", callback_data: "doubt_menu:view" }],
  ];
}

function buildDoubtSubjectPickKeyboard(tasks: Task[]): InlineKeyboard {
  const timerTasks = tasks.filter((t) => t.type === "timer" && !t.is_system);
  const rows: InlineKeyboard = timerTasks.map((t) => [
    { text: `${taskEmoji(t)} ${t.name}`, callback_data: `doubt_pick:${t.id}` },
  ]);
  rows.push([{ text: "❌ Cancel", callback_data: "wizard_cancel" }]);
  return rows;
}

function buildDoubtTopicKeyboard(
  task: Task,
  topics: { topic: string; count: number }[]
): { text: string; keyboard: InlineKeyboard } {
  if (topics.length === 0) {
    return {
      text:
        `📚 <b>${task.name} — Log a Doubt</b>\n\n` +
        `What is the <b>topic</b> or chapter?\n` +
        `<i>(e.g., Electrostatics, Next.js, Optics)</i>`,
      keyboard: [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]],
    };
  }

  const topicButtons: InlineKeyboard = [];
  for (let i = 0; i < topics.length; i += 2) {
    const row = [
      {
        text: `📑 ${topics[i].topic} (${topics[i].count})`,
        callback_data: `doubt_tpick:${i}`,
      },
    ];
    if (i + 1 < topics.length) {
      row.push({
        text: `📑 ${topics[i + 1].topic} (${topics[i + 1].count})`,
        callback_data: `doubt_tpick:${i + 1}`,
      });
    }
    topicButtons.push(row);
  }

  topicButtons.push([{ text: "➕ New Topic", callback_data: `doubt_tnew:${task.id}` }]);
  topicButtons.push([{ text: "❌ Cancel", callback_data: "wizard_cancel" }]);

  return {
    text:
      `📚 <b>${task.name} — Select Topic</b>\n\n` +
      `Pick an existing topic below, or tap <b>➕ New Topic</b>:`,
    keyboard: topicButtons,
  };
}

function buildDoubtListView(
  task: Task,
  topic: string,
  page: number,
  doubts: any[],
  total: number
): { text: string; keyboard: InlineKeyboard } {
  const pageSize = 5;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const topicLabel = topic === "all" ? "All Topics" : topic;
  let text = `📚 <b>${task.name}</b> > <b>${topicLabel}</b>\n`;
  if (total === 0) {
    text += `\n<i>No doubts logged for this topic yet!</i>`;
    return {
      text,
      keyboard: [
        [{ text: "➕ Log a Doubt", callback_data: `doubt_pick:${task.id}` }],
        [{ text: "🔙 Back to Topics", callback_data: "doubt_back_topics" }],
      ],
    };
  }

  const startIdx = (safePage - 1) * pageSize + 1;
  const endIdx = Math.min(total, safePage * pageSize);
  text += `Showing <b>${startIdx}–${endIdx}</b> of <b>${total}</b> doubts (Page ${safePage}/${totalPages}):\n\n`;

  const kb: InlineKeyboard = [];

  doubts.forEach((d, idx) => {
    const num = startIdx + idx;
    const isResolved = d.summary?.includes("Resolved");
    const icon = isResolved ? "✅" : "❓";
    const dateStr = d.log_date || "";
    const top = extractDoubtTopic(d);
    const q = extractDoubtQuestion(d);

    text += `${num}. ${icon} <i>[${dateStr}${topic === "all" ? ` · ${top}` : ""}]</i>\n`;
    text += `   ${q}\n\n`;

    const doubtId = d.id || "";
    const actionRow = [];
    if (isResolved) {
      actionRow.push({
        text: `⭕ Reopen #${num}`,
        callback_data: `doubt_reop:${doubtId}`,
      });
    } else {
      actionRow.push({
        text: `✅ Resolve #${num}`,
        callback_data: `doubt_res:${doubtId}`,
      });
    }
    actionRow.push({
      text: `🗑️ Del #${num}`,
      callback_data: `doubt_del_ask:${doubtId}`,
    });
    kb.push(actionRow);
  });

  const navRow = [];
  if (safePage > 1) {
    navRow.push({
      text: "⬅️ Prev 5",
      callback_data: `doubt_page:${safePage - 1}`,
    });
  }
  if (safePage < totalPages) {
    navRow.push({
      text: "➡️ Next 5 (More)",
      callback_data: `doubt_page:${safePage + 1}`,
    });
  }
  if (navRow.length > 0) {
    kb.push(navRow);
  }

  kb.push([
    { text: "🔙 Back to Topics", callback_data: "doubt_back_topics" },
    { text: "📋 Main Menu", callback_data: "doubt_menu:view" },
  ]);

  return { text, keyboard: kb };
}

// Parse schedule days: supports "daily", or comma/dot-separated days e.g. "Mon, Wed, Fri"
function parseScheduleDays(input: string): string | null {
  const clean = input.trim();
  const lower = clean.toLowerCase();

  if (
    lower === "daily" ||
    lower === "every day" ||
    lower === "everyday" ||
    lower === "all" ||
    lower === "all days"
  ) {
    return "daily";
  }
  if (lower === "weekdays" || lower === "weekday") {
    return "Mon, Tue, Wed, Thu, Fri";
  }
  if (lower === "weekends" || lower === "weekend") {
    return "Sat, Sun";
  }

  const dayMap: Record<string, string> = {
    mon: "Mon", monday: "Mon", mondays: "Mon",
    tue: "Tue", tues: "Tue", tuesday: "Tue", tuesdays: "Tue",
    wed: "Wed", weds: "Wed", wednesday: "Wed", wednesdays: "Wed",
    thu: "Thu", thur: "Thu", thurs: "Thu", thursday: "Thu", thursdays: "Thu",
    fri: "Fri", friday: "Fri", fridays: "Fri",
    sat: "Sat", saturday: "Sat", saturdays: "Sat",
    sun: "Sun", sunday: "Sun", sundays: "Sun",
  };

  // Split by comma, dot, slash, or whitespace
  const rawParts = clean
    .split(/[,.\s/]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  if (rawParts.length === 0) return null;

  const recognizedDays: string[] = [];
  for (const part of rawParts) {
    if (!dayMap[part]) {
      // Reject any unrecognized token (e.g. typos, junk words)
      return null;
    }
    const standardName = dayMap[part];
    if (!recognizedDays.includes(standardName)) {
      recognizedDays.push(standardName);
    }
  }

  if (recognizedDays.length === 7) return "daily";
  if (recognizedDays.length > 0) return recognizedDays.join(", ");
  return null;
}

// "🔀 Split: 1h 0m on Sep 26 + 2h 0m today" (empty when the session did not cross midnight)
function formatSplitSummary(parts: { date: string; minutes: number }[]): string {
  if (parts.length < 2) return "";
  const last = parts.length - 1;
  const pieces = parts.map(
    (p, i) => `${formatTimerMinutes(p.minutes)} ${i === last ? "today" : `on ${localDateShort(p.date)}`}`
  );
  return `\n🔀 Split: ${pieces.join(" + ")}`;
}

// Build task list keyboard buttons
// todayOnly = true  → only tasks scheduled today (for /tasks)
// todayOnly = false → all tasks (for /alltasks)
async function buildTaskListButtons(
  tasks: Task[],
  todayOnly: boolean
): Promise<InlineKeyboard> {
  const filtered = todayOnly
    ? tasks.filter((t) => isTaskScheduledForToday(t.target_days))
    : tasks;

  const buttons: InlineKeyboard = [];
  for (const t of filtered) {
    if (t.type === "tick") {
      const isDone = await isTaskCompletedToday(t.id);
      buttons.push([
        {
          text: `${isDone ? "✅" : "📌"} ${t.name}${isDone ? " (Done)" : ""}`,
          callback_data: `select_task:${t.id}`,
        },
      ]);
    } else if (t.type === "timer") {
      const todayMins = await getTodayTaskTotal(t.name);
      buttons.push([
        {
          text: `${taskEmoji(t)} ${t.name} (${formatTimerMinutes(todayMins)} / ${formatGoalDisplay(t.target_value, "minutes")})`,
          callback_data: `select_task:${t.id}`,
        },
      ]);
    } else {
      const todayCount = await getTodayTaskTotal(t.name);
      buttons.push([
        {
          text: `💧 ${t.name} (${todayCount.toLocaleString()} / ${formatGoalDisplay(t.target_value, t.unit)})`,
          callback_data: `select_task:${t.id}`,
        },
      ]);
    }
  }
  return buttons;
}

// =========================================================================
// MAIN WEBHOOK HANDLER
// =========================================================================

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // =========================================================================
    // SECURITY GUARD: Allow ONLY the authorized user ID
    // =========================================================================
    const allowedUserId = process.env.ALLOWED_TELEGRAM_USER_ID;
    const senderId = String(body.message?.from?.id || body.callback_query?.from?.id || "");
    const chatId = body.message?.chat?.id || body.callback_query?.message?.chat?.id;

    if (allowedUserId && senderId && senderId !== allowedUserId) {
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          "🔒 <b>Access Denied:</b> This is a private life-log assistant."
        );
      }
      return NextResponse.json({ ok: true });
    }

    // =========================================================================
    // 1. HANDLE BUTTON CLICKS (Callback Queries)
    // =========================================================================
    if (body.callback_query) {
      const callbackQuery = body.callback_query;
      const callbackData = callbackQuery.data as string;
      const chatId = callbackQuery.message?.chat?.id;
      const messageId = callbackQuery.message?.message_id;

      // Reject taps on outdated wizard prompts (old messages keep their buttons)
      if (isWizardCallback(callbackData)) {
        const session = await getWizardSession(chatId);
        const expectedPromptId = session?.task_data?.promptMessageId;
        if (session && expectedPromptId && messageId && messageId !== expectedPromptId) {
          await answerCallbackQuery(
            callbackQuery.id,
            "⚠️ This option is outdated — please use the latest message."
          );
          return NextResponse.json({ ok: true });
        }
      } else if (isTimerCallback(callbackData)) {
        // Validate by session start, not by message id: every message showing the
        // SAME running timer stays usable, but buttons from an older session are rejected.
        const parts = callbackData.split(":");
        const sessionEpoch = callbackData.startsWith("timer_pause:")
          ? parseInt(parts[1], 10)
          : parseInt(parts[2], 10);

        if (sessionEpoch) {
          const active = await getActiveTimer(chatId);
          if (active && new Date(active.started_at).getTime() !== sessionEpoch) {
            await answerCallbackQuery(
              callbackQuery.id,
              "⚠️ This timer is outdated — please use the latest timer message."
            );
            return NextResponse.json({ ok: true });
          }
        }
      }

      // Acknowledge receipt to remove button loading spinner on phone
      await answerCallbackQuery(callbackQuery.id);

      // --- WIZARD: Cancel Active Action ---
      if (callbackData === "wizard_cancel") {
        await clearWizardSession(chatId);
        const cancelText = "❌ <i>Action cancelled.</i>";
        await respondUi(chatId, messageId, cancelText, []);
        return NextResponse.json({ ok: true });
      }

      // --- DIARY: Set / Update Mood ---
      if (callbackData.startsWith("set_mood:")) {
        const parts = callbackData.split(":");
        const logId = parts[1];
        const newMood = parts[2];

        if (logId) {
          await updateDiaryMood(logId, newMood);
        }

        const moodDisplay = formatMoodDisplay(newMood);

        const updatedButtons: InlineKeyboard = [
          [
            { text: newMood === "happy" ? "✅ 😊 Happy" : "😊 Happy", callback_data: `set_mood:${logId}:happy` },
            { text: newMood === "productive" ? "✅ ⚡ Productive" : "⚡ Productive", callback_data: `set_mood:${logId}:productive` },
            { text: newMood === "okay" ? "✅ 😐 Okay" : "😐 Okay", callback_data: `set_mood:${logId}:okay` },
          ],
          [
            { text: newMood === "bad" ? "✅ 😔 Bad" : "😔 Bad", callback_data: `set_mood:${logId}:bad` },
            { text: newMood === "tired" ? "✅ 😴 Tired" : "😴 Tired", callback_data: `set_mood:${logId}:tired` },
            { text: newMood === "grateful" ? "✅ 🙏 Grateful" : "🙏 Grateful", callback_data: `set_mood:${logId}:grateful` },
          ],
        ];

        if (messageId) {
          await editUiMessage(
            chatId,
            messageId,
            `📖 <b>Diary Saved for Today!</b>\n\n` +
              `<b>Mood:</b> ${moodDisplay}\n\n` +
              `<i>Mood updated! Type /today to see your scorecard.</i>`,
            updatedButtons
          );
        }
        return NextResponse.json({ ok: true });
      }

      // --- FOCUS: Tag a task entry's session focus ---
      if (callbackData.startsWith("set_focus:")) {
        const [, logId, value] = callbackData.split(":");
        const allowed = ["focused", "casual", "distracted"];
        if (!logId || !allowed.includes(value)) {
          await respondUi(chatId, messageId, "⚠️ Invalid focus option.", []);
          return NextResponse.json({ ok: true });
        }

        await updateLogFocus(logId, value);

        const label = value === "focused" ? "🎯 Focused" : value === "casual" ? "😐 Casual" : "😵 Distracted";

        const log = await getLogById(logId);
        const projectId = log?.project_id || undefined;
        let projectName: string | undefined;
        if (projectId) {
          const project = await getProjectById(projectId);
          projectName = project?.name;
        }

        // Save wizard session so the user's next message is captured as a session note/summary
        await saveWizardSession(chatId, "awaiting_session_note", {
          sessionLogId: logId,
          promptMessageId: messageId,
          projectId,
          projectName,
        });

        const kb: InlineKeyboard = [
          [{ text: "⏭️ Skip Note", callback_data: `skip_session_note:${logId}` }],
          [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
        ];
        await respondUi(
          chatId,
          messageId,
          `✅ <b>Session focus saved:</b> ${label}\n\n` +
            `📝 <b>What did you work on?</b>\n` +
            `Send a short note or summary for this session, or tap <b>Skip Note</b>:`,
          kb
        );
        return NextResponse.json({ ok: true });
      }

      // --- Skip Session Note Prompt ---
      if (callbackData.startsWith("skip_session_note:")) {
        const logId = callbackData.split(":")[1];
        const session = await getWizardSession(chatId);
        await clearWizardSession(chatId);

        let projectId = session?.task_data?.projectId;
        let projectName = session?.task_data?.projectName;
        if (!projectId && logId) {
          const log = await getLogById(logId);
          projectId = log?.project_id || undefined;
          if (projectId) {
            const project = await getProjectById(projectId);
            projectName = project?.name;
          }
        }

        if (projectId) {
          const projectKb: InlineKeyboard = [
            [
              { text: "✅ Yes, Completed", callback_data: `project_complete:${projectId}` },
              { text: "⏳ No, In Progress", callback_data: `project_keep_open:${projectId}` },
            ],
            [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
          ];
          await respondUi(
            chatId,
            messageId,
            `✅ <b>Session focus saved!</b>\n\n` +
              `🏁 <b>Project: "${projectName || "Active Project"}"</b>\n` +
              `Did you complete this project?`,
            projectKb
          );
          return NextResponse.json({ ok: true });
        }

        await respondUi(
          chatId,
          messageId,
          `✅ <b>Session focus saved!</b>`,
          [[{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }]]
        );
        return NextResponse.json({ ok: true });
      }

      // --- Project Status: Completed ---
      if (callbackData.startsWith("project_complete:")) {
        const projectId = callbackData.split(":")[1];
        const project = await getProjectById(projectId);
        if (project) {
          await markProjectCompleted(projectId);
        }
        const totalMinutes = await getProjectTotalMinutes(projectId);
        const name = project?.name || "Project";
        const targetStr = project?.target_minutes
          ? `\n🎯 <b>Estimated Goal:</b> ${formatTimerMinutes(project.target_minutes)}`
          : "";
        const descStr = project?.description
          ? `\n📝 <b>Scope:</b> <i>${project.description}</i>`
          : "";

        await respondUi(
          chatId,
          messageId,
          `🎉 <b>Project Completed: ${name}!</b>\n\n` +
            `⏱️ <b>Total Time Logged:</b> ${formatTimerMinutes(totalMinutes)}` +
            targetStr +
            descStr +
            `\n\n🏁 <i>Great work! Next time you start this task, you'll be prompted for a new project.</i>`,
          [[{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }]]
        );
        return NextResponse.json({ ok: true });
      }

      // --- Project Status: Keep In Progress ---
      if (callbackData.startsWith("project_keep_open:")) {
        const projectId = callbackData.split(":")[1];
        const project = await getProjectById(projectId);
        const name = project?.name || "Project";
        await respondUi(
          chatId,
          messageId,
          `👍 <b>Progress Saved!</b>\n\n` +
            `⏳ <b>${name}</b> is still in progress.\n` +
            `It will be ready for you to continue next time you start!`,
          [[{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }]]
        );
        return NextResponse.json({ ok: true });
      }

      // --- TODO: Show / Refresh List (pending only; done items are hidden) ---
      if (callbackData === "todo_list") {
        const todos = await getTodos();
        await respondUi(chatId, messageId, buildTodoListText(todos), buildTodoListKeyboard(todos));
        return NextResponse.json({ ok: true });
      }

      // --- TODO: Start Add Flow ---
      if (callbackData.startsWith("todo_add:")) {
        await sendWizardPrompt(
          chatId,
          "awaiting_todo_title",
          {},
          `📝 <b>New To-Do</b>\n\nWhat's the task?\n<i>(e.g., "Submit assignment", "Call plumber")</i>`,
          [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]],
          messageId
        );
        return NextResponse.json({ ok: true });
      }

      // --- TODO: Quick Date Buttons -> Time Step ---
      if (callbackData.startsWith("todo_date:")) {
        const session = await getWizardSession(chatId);
        if (!session || session.step !== "awaiting_todo_date" || !session.task_data.todoTitle) {
          await respondUi(chatId, messageId, "⚠️ Session expired. Type /todo to start again.", []);
          return NextResponse.json({ ok: true });
        }

        const which = callbackData.split(":")[1];
        const dateStr = localDateString(new Date(Date.now() + (which === "tomorrow" ? 86400000 : 0)));
        const taskData = { ...session.task_data, todoDate: dateStr };

        await sendWizardPrompt(
          chatId,
          "awaiting_todo_time",
          taskData,
          todoTimePrompt(taskData.todoTitle!, dateStr),
          todoTimeKb(),
          messageId
        );
        return NextResponse.json({ ok: true });
      }

      // --- TODO: Quick Time Buttons -> Save ---
      if (callbackData.startsWith("todo_time:")) {
        const session = await getWizardSession(chatId);
        if (!session || session.step !== "awaiting_todo_time" || !session.task_data.todoTitle || !session.task_data.todoDate) {
          await respondUi(chatId, messageId, "⚠️ Session expired. Type /todo to start again.", []);
          return NextResponse.json({ ok: true });
        }

        const hhmm = callbackData.split(":")[1];
        const dueAt = zonedDateTimeToUtc(session.task_data.todoDate, `${hhmm}:00`);
        if (dueAt.getTime() <= Date.now()) {
          await sendWizardPrompt(
            chatId,
            "awaiting_todo_time",
            session.task_data,
            `⚠️ That time has already passed. Please pick a later time:`,
            todoTimeKb(),
            messageId
          );
          return NextResponse.json({ ok: true });
        }

        const todo = await createTodo(session.task_data.todoTitle, dueAt.toISOString());
        await clearWizardSession(chatId);

        if (!todo) {
          await respondUi(chatId, messageId, "⚠️ Could not save the to-do. Please try again.", []);
          return NextResponse.json({ ok: true });
        }
        const view = buildTodoView(todo);
        await respondUi(chatId, messageId, `✅ <b>To-Do saved!</b>\n\n${view.text}`, view.keyboard);
        return NextResponse.json({ ok: true });
      }

      // --- TODO: View ---
      if (callbackData.startsWith("todo_view:")) {
        const todo = await getTodoById(callbackData.split(":")[1]);
        if (!todo) {
          await respondUi(chatId, messageId, "⚠️ To-Do not found.", []);
          return NextResponse.json({ ok: true });
        }
        const view = buildTodoView(todo);
        await respondUi(chatId, messageId, view.text, view.keyboard);
        return NextResponse.json({ ok: true });
      }

      // --- TODO: Mark Done (stays in DB, no reminder will fire) ---
      if (callbackData.startsWith("todo_done:")) {
        const todo = await setTodoDone(callbackData.split(":")[1], true);
        if (!todo) {
          await respondUi(chatId, messageId, "⚠️ To-Do not found.", []);
          return NextResponse.json({ ok: true });
        }
        const todos = await getTodos();
        await respondUi(
          chatId,
          messageId,
          `🎉 <b>Ticked:</b> ${todo.title}\n\n${buildTodoListText(todos)}`,
          buildTodoListKeyboard(todos)
        );
        return NextResponse.json({ ok: true });
      }

      // --- TODO: Delete (only reachable for not-done todos; done ones are hidden) ---
      if (callbackData.startsWith("todo_delete:")) {
        const todo = await getTodoById(callbackData.split(":")[1]);
        if (!todo) {
          await respondUi(chatId, messageId, "⚠️ To-Do not found.", []);
          return NextResponse.json({ ok: true });
        }
        await respondUi(
          chatId,
          messageId,
          `🗑️ <b>Delete "${todo.title}"?</b>\n\nThis removes it from your to-do list.`,
          [
            [{ text: "🗑️ Yes, Delete", callback_data: `todo_confirm_delete:${todo.id}` }],
            [{ text: "❌ Cancel", callback_data: `todo_view:${todo.id}` }],
          ]
        );
        return NextResponse.json({ ok: true });
      }

      // --- TODO: Delete (confirmed) ---
      if (callbackData.startsWith("todo_confirm_delete:")) {
        const todo = await getTodoById(callbackData.split(":")[1]);
        if (todo) await deleteTodo(todo.id);
        const todos = await getTodos();
        await respondUi(
          chatId,
          messageId,
          `🗑️ Deleted${todo ? `: <b>${todo.title}</b>` : ""}.\n\n${buildTodoListText(todos)}`,
          buildTodoListKeyboard(todos)
        );
        return NextResponse.json({ ok: true });
      }

      // --- DOUBT: Menu (Log Doubt) ---
      if (callbackData === "doubt_menu:log") {
        await clearWizardSessionAndRetirePrompt(chatId);
        const tasks = await getActiveTasks();
        const timerTasks = tasks.filter((t) => t.type === "timer" && !t.is_system);
        if (timerTasks.length === 0) {
          await respondUi(
            chatId,
            messageId,
            `⚠️ <b>No active study/work routines found.</b>\n\n` +
              `Please use <b>/addtask</b> to create a timer routine (e.g. "Physics Study", "Vibe Coding") first!`,
            [[{ text: "➕ Add Routine", callback_data: "wizard_type:timer" }], [{ text: "❌ Cancel", callback_data: "wizard_cancel" }]]
          );
          return NextResponse.json({ ok: true });
        }
        await respondUi(
          chatId,
          messageId,
          `📚 <b>Log a Doubt</b>\n\nSelect the subject or routine:`,
          buildDoubtSubjectPickKeyboard(tasks)
        );
        return NextResponse.json({ ok: true });
      }

      // --- DOUBT: Menu (View Doubts) ---
      if (callbackData === "doubt_menu:view") {
        await clearWizardSessionAndRetirePrompt(chatId);
        const tasksWithDoubts = await getTasksWithDoubts();
        if (tasksWithDoubts.length === 0) {
          await respondUi(
            chatId,
            messageId,
            `⚠️ <b>No timer routines found.</b>\n\nCreate a timer routine via <b>/addtask</b> first.`,
            [[{ text: "➕ Add Routine", callback_data: "wizard_type:timer" }]]
          );
          return NextResponse.json({ ok: true });
        }

        const totalDoubtsAcrossAll = tasksWithDoubts.reduce((s, t) => s + t.count, 0);
        if (totalDoubtsAcrossAll === 0) {
          await respondUi(
            chatId,
            messageId,
            `ℹ️ <b>No doubts logged yet!</b>\n\nTap below to record your first doubt:`,
            [
              [{ text: "➕ Log New Doubt", callback_data: "doubt_menu:log" }],
              [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
            ]
          );
          return NextResponse.json({ ok: true });
        }

        const kb: InlineKeyboard = tasksWithDoubts
          .filter((item) => item.count > 0)
          .map((item) => [
            {
              text: `${taskEmoji(item.task)} ${item.task.name} (${item.count})`,
              callback_data: `doubt_topics:${item.task.id}`,
            },
          ]);

        kb.push([{ text: "➕ Log New Doubt", callback_data: "doubt_menu:log" }]);
        kb.push([{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }]);

        await respondUi(
          chatId,
          messageId,
          `📚 <b>Your Doubts by Subject</b>\nSelect a subject to view topics and questions:`,
          kb
        );
        return NextResponse.json({ ok: true });
      }

      // --- DOUBT: Pick Subject to Log ---
      if (callbackData.startsWith("doubt_pick:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        if (!task) {
          await respondUi(chatId, messageId, "⚠️ Task not found or already archived.", []);
          return NextResponse.json({ ok: true });
        }

        await saveWizardSession(chatId, "awaiting_doubt_topic", {
          doubtTaskId: task.id,
          doubtTaskName: task.name,
        });

        const topics = await getDoubtTopics(task.id);
        if (topics.length > 0) {
          const view = buildDoubtTopicKeyboard(task, topics);
          await respondUi(chatId, messageId, view.text, view.keyboard);
          return NextResponse.json({ ok: true });
        }

        await sendWizardPrompt(
          chatId,
          "awaiting_doubt_topic",
          { doubtTaskId: task.id, doubtTaskName: task.name },
          `📚 <b>${task.name} — Log a Doubt</b>\n\n` +
            `What is the <b>topic</b> or chapter?\n` +
            `<i>(e.g., Electrostatics, Next.js, Optics)</i>`,
          [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]],
          messageId
        );
        return NextResponse.json({ ok: true });
      }

      // --- DOUBT: Prompt for New Topic Text ---
      if (callbackData.startsWith("doubt_tnew:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        if (!task) {
          await respondUi(chatId, messageId, "⚠️ Task not found.", []);
          return NextResponse.json({ ok: true });
        }

        await sendWizardPrompt(
          chatId,
          "awaiting_doubt_topic",
          { doubtTaskId: task.id, doubtTaskName: task.name },
          `📚 <b>${task.name} — New Topic</b>\n\n` +
            `Please type the topic or chapter name:\n` +
            `<i>(e.g., Electrostatics, Next.js, Optics)</i>`,
          [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]],
          messageId
        );
        return NextResponse.json({ ok: true });
      }

      // --- DOUBT: Pick Existing Topic from Buttons -> Ask Doubt ---
      if (callbackData.startsWith("doubt_tpick:")) {
        const idx = parseInt(callbackData.split(":")[1], 10);
        const session = await getWizardSession(chatId);
        const taskId = session?.task_data?.doubtTaskId;
        const task = taskId ? await getTaskById(taskId) : null;
        if (!task) {
          await respondUi(chatId, messageId, "⚠️ Task session expired. Type /doubt to restart.", []);
          return NextResponse.json({ ok: true });
        }

        const topics = await getDoubtTopics(task.id);
        const topic = topics[idx]?.topic || "General";

        await sendWizardPrompt(
          chatId,
          "awaiting_doubt_text",
          { doubtTaskId: task.id, doubtTaskName: task.name, doubtTopic: topic },
          `❓ <b>${task.name} — ${topic}</b>\n\n` +
            `What is your <b>doubt</b>? Explain what you are stuck on:\n` +
            `<i>(Type your question or notes)</i>`,
          [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]],
          messageId
        );
        return NextResponse.json({ ok: true });
      }

      // --- DOUBT: Confirm Suggested Topic or Use Typo ---
      if (callbackData.startsWith("doubt_tconfirm:")) {
        const choice = callbackData.split(":")[1];
        const session = await getWizardSession(chatId);
        const taskId = session?.task_data?.doubtTaskId;
        const task = taskId ? await getTaskById(taskId) : null;
        if (!task) {
          await respondUi(chatId, messageId, "⚠️ Session expired. Type /doubt to restart.", []);
          return NextResponse.json({ ok: true });
        }

        const chosenTopic =
          choice === "yes"
            ? session?.task_data?.suggestedTopic || session?.task_data?.doubtTopic || "General"
            : session?.task_data?.doubtTopic || "General";

        await sendWizardPrompt(
          chatId,
          "awaiting_doubt_text",
          { doubtTaskId: task.id, doubtTaskName: task.name, doubtTopic: chosenTopic },
          `❓ <b>${task.name} — ${chosenTopic}</b>\n\n` +
            `What is your <b>doubt</b>? Explain what you are stuck on:\n` +
            `<i>(Type your question or notes)</i>`,
          [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]],
          messageId
        );
        return NextResponse.json({ ok: true });
      }

      // --- DOUBT: View Topics for Subject ---
      if (callbackData.startsWith("doubt_topics:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        if (!task) {
          await respondUi(chatId, messageId, "⚠️ Task not found.", []);
          return NextResponse.json({ ok: true });
        }

        await saveWizardSession(chatId, "view_doubts", {
          doubtTaskId: task.id,
          doubtTaskName: task.name,
        });

        const topics = await getDoubtTopics(task.id);
        const total = topics.reduce((s, t) => s + t.count, 0);

        if (topics.length === 0) {
          await respondUi(
            chatId,
            messageId,
            `ℹ️ No doubts logged yet for <b>${task.name}</b>.`,
            [
              [{ text: "➕ Log a Doubt", callback_data: `doubt_pick:${task.id}` }],
              [{ text: "🔙 Back to Subjects", callback_data: "doubt_menu:view" }],
            ]
          );
          return NextResponse.json({ ok: true });
        }

        const kb: InlineKeyboard = [];
        for (let i = 0; i < topics.length; i += 2) {
          const row = [
            {
              text: `📑 ${topics[i].topic} (${topics[i].count})`,
              callback_data: `doubt_top:${i}`,
            },
          ];
          if (i + 1 < topics.length) {
            row.push({
              text: `📑 ${topics[i + 1].topic} (${topics[i + 1].count})`,
              callback_data: `doubt_top:${i + 1}`,
            });
          }
          kb.push(row);
        }

        kb.push([
          {
            text: `📑 All Topics (${total})`,
            callback_data: `doubt_top:all`,
          },
        ]);
        kb.push([{ text: "➕ Log a Doubt", callback_data: `doubt_pick:${task.id}` }]);
        kb.push([{ text: "🔙 Back to Subjects", callback_data: "doubt_menu:view" }]);

        await respondUi(
          chatId,
          messageId,
          `📚 <b>${task.name} — Select Topic</b>\nChoose a topic to view its questions:`,
          kb
        );
        return NextResponse.json({ ok: true });
      }

      // --- DOUBT: Select Topic to View Doubts ---
      if (callbackData.startsWith("doubt_top:")) {
        const choice = callbackData.split(":")[1];
        const session = await getWizardSession(chatId);
        const taskId = session?.task_data?.doubtTaskId;
        const task = taskId ? await getTaskById(taskId) : null;
        if (!task) {
          await respondUi(chatId, messageId, "⚠️ Session expired. Type /doubt to restart.", []);
          return NextResponse.json({ ok: true });
        }

        let topic = "all";
        if (choice !== "all") {
          const idx = parseInt(choice, 10);
          const topics = await getDoubtTopics(task.id);
          topic = topics[idx]?.topic || "all";
        }

        await saveWizardSession(chatId, "view_doubts", {
          doubtTaskId: task.id,
          doubtTaskName: task.name,
          doubtTopic: topic,
          doubtPage: 1,
        });

        const { doubts, total } = await getDoubts({ taskId: task.id, topic, page: 1, pageSize: 5 });
        const view = buildDoubtListView(task, topic, 1, doubts, total);
        await respondUi(chatId, messageId, view.text, view.keyboard);
        return NextResponse.json({ ok: true });
      }

      // --- DOUBT: Pagination ---
      if (callbackData.startsWith("doubt_page:")) {
        const page = parseInt(callbackData.split(":")[1], 10) || 1;
        const session = await getWizardSession(chatId);
        const taskId = session?.task_data?.doubtTaskId;
        const task = taskId ? await getTaskById(taskId) : null;
        if (!task) {
          await respondUi(chatId, messageId, "⚠️ Session expired. Type /doubt to restart.", []);
          return NextResponse.json({ ok: true });
        }

        const topic = session?.task_data?.doubtTopic || "all";
        await saveWizardSession(chatId, "view_doubts", {
          ...session?.task_data,
          doubtPage: page,
        });

        const { doubts, total } = await getDoubts({ taskId: task.id, topic, page, pageSize: 5 });
        const view = buildDoubtListView(task, topic, page, doubts, total);
        await respondUi(chatId, messageId, view.text, view.keyboard);
        return NextResponse.json({ ok: true });
      }

      // --- DOUBT: Back to Topics ---
      if (callbackData === "doubt_back_topics") {
        const session = await getWizardSession(chatId);
        const taskId = session?.task_data?.doubtTaskId;
        if (taskId) {
          const task = await getTaskById(taskId);
          if (task) {
            const topics = await getDoubtTopics(task.id);
            const total = topics.reduce((s, t) => s + t.count, 0);

            const kb: InlineKeyboard = [];
            for (let i = 0; i < topics.length; i += 2) {
              const row = [
                {
                  text: `📑 ${topics[i].topic} (${topics[i].count})`,
                  callback_data: `doubt_top:${i}`,
                },
              ];
              if (i + 1 < topics.length) {
                row.push({
                  text: `📑 ${topics[i + 1].topic} (${topics[i + 1].count})`,
                  callback_data: `doubt_top:${i + 1}`,
                });
              }
              kb.push(row);
            }

            kb.push([
              {
                text: `📑 All Topics (${total})`,
                callback_data: `doubt_top:all`,
              },
            ]);
            kb.push([{ text: "➕ Log a Doubt", callback_data: `doubt_pick:${task.id}` }]);
            kb.push([{ text: "🔙 Back to Subjects", callback_data: "doubt_menu:view" }]);

            await respondUi(
              chatId,
              messageId,
              `📚 <b>${task.name} — Select Topic</b>\nChoose a topic to view its questions:`,
              kb
            );
            return NextResponse.json({ ok: true });
          }
        }
        await respondUi(chatId, messageId, buildDoubtMenuText(), buildDoubtMenuKeyboard());
        return NextResponse.json({ ok: true });
      }

      // --- DOUBT: Mark Resolved ---
      if (callbackData.startsWith("doubt_res:")) {
        const doubtId = callbackData.split(":")[1];
        await toggleDoubtStatus(doubtId, true);

        const session = await getWizardSession(chatId);
        const taskId = session?.task_data?.doubtTaskId;
        const task = taskId ? await getTaskById(taskId) : null;
        if (task) {
          const topic = session?.task_data?.doubtTopic || "all";
          const page = session?.task_data?.doubtPage || 1;
          const { doubts, total } = await getDoubts({ taskId: task.id, topic, page, pageSize: 5 });
          const view = buildDoubtListView(task, topic, page, doubts, total);
          await respondUi(chatId, messageId, view.text, view.keyboard);
        }
        return NextResponse.json({ ok: true });
      }

      // --- DOUBT: Reopen Resolved Doubt ---
      if (callbackData.startsWith("doubt_reop:")) {
        const doubtId = callbackData.split(":")[1];
        await toggleDoubtStatus(doubtId, false);

        const session = await getWizardSession(chatId);
        const taskId = session?.task_data?.doubtTaskId;
        const task = taskId ? await getTaskById(taskId) : null;
        if (task) {
          const topic = session?.task_data?.doubtTopic || "all";
          const page = session?.task_data?.doubtPage || 1;
          const { doubts, total } = await getDoubts({ taskId: task.id, topic, page, pageSize: 5 });
          const view = buildDoubtListView(task, topic, page, doubts, total);
          await respondUi(chatId, messageId, view.text, view.keyboard);
        }
        return NextResponse.json({ ok: true });
      }

      // --- DOUBT: Ask Delete Confirmation ---
      if (callbackData.startsWith("doubt_del_ask:")) {
        const doubtId = callbackData.split(":")[1];
        const doubt = await getDoubtById(doubtId);
        const q = doubt ? extractDoubtQuestion(doubt) : "this doubt";
        const session = await getWizardSession(chatId);
        const page = session?.task_data?.doubtPage || 1;

        await respondUi(
          chatId,
          messageId,
          `🗑️ <b>Delete this doubt permanently?</b>\n\n<i>"${q.slice(0, 150)}"</i>`,
          [
            [
              {
                text: "🗑️ Yes, Delete",
                callback_data: `doubt_del_conf:${doubtId}`,
              },
            ],
            [
              {
                text: "❌ Cancel",
                callback_data: `doubt_page:${page}`,
              },
            ],
          ]
        );
        return NextResponse.json({ ok: true });
      }

      // --- DOUBT: Confirm Delete ---
      if (callbackData.startsWith("doubt_del_conf:")) {
        const doubtId = callbackData.split(":")[1];
        await deleteDoubt(doubtId);

        const session = await getWizardSession(chatId);
        const taskId = session?.task_data?.doubtTaskId;
        const task = taskId ? await getTaskById(taskId) : null;
        if (task) {
          const topic = session?.task_data?.doubtTopic || "all";
          const page = session?.task_data?.doubtPage || 1;
          const { doubts, total } = await getDoubts({ taskId: task.id, topic, page, pageSize: 5 });
          const view = buildDoubtListView(task, topic, page, doubts, total);
          await respondUi(chatId, messageId, view.text, view.keyboard);
        }
        return NextResponse.json({ ok: true });
      }

      // --- WIZARD: Step 1 Pick Type -> Prompt Name ---
      if (callbackData.startsWith("wizard_type:")) {
        const type = callbackData.split(":")[1] as TaskType;

        let promptText = "";
        if (type === "timer") {
          promptText =
            `📝 <b>Task Name (Timer)</b>\n\n` +
            `What is the name of this timer task?\n` +
            `<i>(e.g., "Physics Study", "Coding", "Reading Books")</i>`;
        } else if (type === "counter") {
          promptText =
            `📝 <b>Task Name (Count)</b>\n\n` +
            `What is the name of this count task?\n` +
            `<i>(e.g., "Walking", "Drink Water", "Pushups", "Pages Read")</i>`;
        } else {
          promptText =
            `📝 <b>Task Name (Daily Tick)</b>\n\n` +
            `What is the name of this daily routine?\n` +
            `<i>(e.g., "Wake Up at 5am", "Meditation", "Cold Shower")</i>`;
        }

        const cancelKb: InlineKeyboard = [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]];

        const previousSession = await getWizardSession(chatId);
        if (previousSession?.task_data?.promptMessageId && previousSession.task_data.promptMessageId !== messageId) {
          await removeInlineKeyboard(chatId, previousSession.task_data.promptMessageId);
        }

        await sendWizardPrompt(chatId, "awaiting_name", { type }, promptText, cancelKb, messageId);
        return NextResponse.json({ ok: true });
      }

      // --- WIZARD: Quick Timer Target Button (e.g. 60, 120 mins) -> Prompt Reminder ---
      if (callbackData.startsWith("wizard_timer_target:")) {
        const mins = parseInt(callbackData.split(":")[1], 10);
        const session = await getWizardSession(chatId);
        if (!session) {
          await sendTelegramMessage(chatId, "⚠️ Session expired. Type /addtask to start again.");
          return NextResponse.json({ ok: true });
        }

        const taskData = {
          ...session.task_data,
          target_value: mins,
          unit: "minutes",
        };

        const reminderPrompt =
          `⏰ <b>Reminder Time</b>\n\n` +
          `Task: <b>${taskData.name}</b>\n` +
          `Goal: <b>${formatGoalDisplay(mins, "minutes")}</b>\n\n` +
          `What time should I remind you daily?\n` +
          `<i>(e.g., "08:00 AM", "8am", "18:30")</i>\n\n` +
          `Or tap <b>Skip Reminder</b> below:`;

        const reminderKb: InlineKeyboard = [
          [{ text: "⏭️ Skip Reminder", callback_data: "wizard_skip:reminder" }],
          [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
        ];

        await sendWizardPrompt(chatId, "awaiting_reminder", taskData, reminderPrompt, reminderKb, messageId);
        return NextResponse.json({ ok: true });
      }

      // --- WIZARD: Quick Counter Target Button (e.g. 5000:ml, 10:km) -> Prompt Reminder ---
      if (callbackData.startsWith("wizard_count_target:")) {
        const [, amtStr, unit] = callbackData.split(":");
        const amt = parseInt(amtStr, 10);
        const session = await getWizardSession(chatId);
        if (!session) {
          await sendTelegramMessage(chatId, "⚠️ Session expired. Type /addtask to start again.");
          return NextResponse.json({ ok: true });
        }

        const taskData = {
          ...session.task_data,
          target_value: amt,
          unit,
        };

        const reminderPrompt =
          `⏰ <b>Reminder Time</b>\n\n` +
          `Task: <b>${taskData.name}</b>\n` +
          `Goal: <b>${formatGoalDisplay(amt, unit)}</b>\n\n` +
          `What time should I remind you daily?\n` +
          `<i>(e.g., "08:00 AM", "8am", "18:30")</i>\n\n` +
          `Or tap <b>Skip Reminder</b> below:`;

        const reminderKb: InlineKeyboard = [
          [{ text: "⏭️ Skip Reminder", callback_data: "wizard_skip:reminder" }],
          [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
        ];

        await sendWizardPrompt(chatId, "awaiting_reminder", taskData, reminderPrompt, reminderKb, messageId);
        return NextResponse.json({ ok: true });
      }

      // --- WIZARD: Skip Reminder -> Prompt Which Days ---
      if (callbackData === "wizard_skip:reminder") {
        const session = await getWizardSession(chatId);
        if (!session) {
          await sendTelegramMessage(chatId, "⚠️ Session expired. Type /addtask to start again.");
          return NextResponse.json({ ok: true });
        }

        const taskData = { ...session.task_data, reminder_time: null };

        const daysPrompt =
          `📅 <b>Which Days?</b>\n\n` +
          `Task: <b>${taskData.name}</b>\n` +
          `Goal: <b>${formatGoalDisplay(taskData.target_value, taskData.unit)}</b>\n` +
          `Reminder: <i>None (Skipped)</i>\n\n` +
          `Tap <b>[ 🌟 Daily ]</b> below, or type the days separated with commas:\n` +
          `<i>(e.g., "Mon, Wed, Fri" or "Monday, Saturday")</i>`;

        const daysKb: InlineKeyboard = [
          [{ text: "🌟 Daily (Every Day)", callback_data: "wizard_days:daily" }],
          [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
        ];

        await sendWizardPrompt(chatId, "awaiting_days", taskData, daysPrompt, daysKb, messageId);
        return NextResponse.json({ ok: true });
      }

      // --- WIZARD: Pick Which Days -> Finalize & Save Task ---
      if (callbackData.startsWith("wizard_days:")) {
        const rawDays = callbackData.split(":")[1];
        const chosenDays = parseScheduleDays(rawDays);
        const session = await getWizardSession(chatId);
        if (!session || !session.task_data.name) {
          await sendTelegramMessage(chatId, "⚠️ Session expired. Type /addtask to start again.");
          return NextResponse.json({ ok: true });
        }

        const taskData = session.task_data;

        // For timer tasks, prompt whether it should be project-based
        if (taskData.type === "timer") {
          await saveWizardSession(chatId, "awaiting_days", {
            ...taskData,
            target_days: chosenDays,
            promptMessageId: messageId,
          });

          const kb: InlineKeyboard = [
            [
              { text: "📦 Yes, Project-Based", callback_data: `wizard_project_toggle:yes:${rawDays}` },
              { text: "⏱️ No, Simple Timer", callback_data: `wizard_project_toggle:no:${rawDays}` },
            ],
            [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
          ];

          await respondUi(
            chatId,
            messageId,
            `📦 <b>Project Tracking for "${taskData.name}"</b>\n\n` +
              `Do you want this timer to be project-based?\n\n` +
              `• <b>Project-based:</b> Before starting, asks what project you're working on. When stopped, tracks project time and asks if you finished it.\n` +
              `• <b>Simple Timer:</b> Just a regular habit stopwatch.`,
            kb
          );
          return NextResponse.json({ ok: true });
        }

        const newTask = await createTask({
          name: taskData.name,
          type: taskData.type || "counter",
          target_value: taskData.target_value || (taskData.type === "tick" ? 1 : 5000),
          unit: taskData.unit || (taskData.type === "tick" ? "status" : "ml"),
          reminder_time: taskData.reminder_time || null,
          target_days: chosenDays,
          is_project_based: false,
        });

        await clearWizardSession(chatId);

        if (!newTask) {
          await respondUi(chatId, messageId, `⚠️ Could not create task (name may already exist).`, []);
          return NextResponse.json({ ok: true });
        }

        const typeIcon = taskEmoji(newTask);
        const successText =
          `🎉 <b>Task Created Successfully!</b>\n\n` +
          `📌 <b>${newTask.name}</b>\n` +
          `${typeIcon} Type: <b>${newTask.type.toUpperCase()}</b>\n` +
          `🎯 Goal: <b>${formatGoalDisplay(newTask.target_value, newTask.unit)}</b>\n` +
          `⏰ Reminder: <b>${formatReminderTime(newTask.reminder_time)}</b>\n` +
          `📅 Days: <b>${formatScheduleDisplay(getTaskSchedule(newTask))}</b>\n\n` +
          `Type /tasks to view your routines anytime!`;

        const actionButtons: InlineKeyboard = [];
        if (newTask.type === "timer") {
          actionButtons.push([{ text: `▶️ Start ${newTask.name} Now`, callback_data: `start_task:${newTask.id}` }]);
        } else if (newTask.type === "counter") {
          actionButtons.push([{ text: `+ Add Progress`, callback_data: `select_task:${newTask.id}` }]);
        } else if (newTask.type === "tick") {
          actionButtons.push([{ text: `✅ Mark Done for Today`, callback_data: `tick_task:${newTask.id}` }]);
        }
        actionButtons.push([{ text: "📋 View Tasks", callback_data: "menu_tasks" }]);

        await respondUi(chatId, messageId, successText, actionButtons);
        return NextResponse.json({ ok: true });
      }

      // --- WIZARD: Project-Based Toggle Choice -> Finalize Timer Task ---
      if (callbackData.startsWith("wizard_project_toggle:")) {
        const [, choice, rawDays] = callbackData.split(":");
        const isProjectBased = choice === "yes";
        const chosenDays = parseScheduleDays(rawDays) || "daily";
        const session = await getWizardSession(chatId);
        if (!session || !session.task_data.name) {
          await sendTelegramMessage(chatId, "⚠️ Session expired. Type /addtask to start again.");
          return NextResponse.json({ ok: true });
        }

        const taskData = session.task_data;
        const newTask = await createTask({
          name: taskData.name,
          type: "timer",
          target_value: taskData.target_value || 60,
          unit: "minutes",
          reminder_time: taskData.reminder_time || null,
          target_days: chosenDays,
          is_project_based: isProjectBased,
        });

        await clearWizardSession(chatId);

        if (!newTask) {
          await respondUi(chatId, messageId, `⚠️ Could not create task (name may already exist).`, []);
          return NextResponse.json({ ok: true });
        }

        const successText =
          `🎉 <b>Task Created Successfully!</b>\n\n` +
          `📌 <b>${newTask.name}</b>\n` +
          `⏱️ Type: <b>TIMER</b>\n` +
          `🎯 Goal: <b>${formatGoalDisplay(newTask.target_value, newTask.unit)}</b>\n` +
          `⏰ Reminder: <b>${formatReminderTime(newTask.reminder_time)}</b>\n` +
          `📅 Days: <b>${formatScheduleDisplay(getTaskSchedule(newTask))}</b>\n` +
          `📦 Project Tracking: <b>${isProjectBased ? "Enabled (Project-Based)" : "Disabled"}</b>\n\n` +
          `Type /tasks to view your routines anytime!`;

        const actionButtons: InlineKeyboard = [
          [{ text: `▶️ Start ${newTask.name} Now`, callback_data: `start_task:${newTask.id}` }],
          [{ text: "📋 View Tasks", callback_data: "menu_tasks" }],
        ];

        await respondUi(chatId, messageId, successText, actionButtons);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Show Task List (Today Only) ---
      if (callbackData === "menu_tasks") {
        await clearWizardSession(chatId);
        await setActiveTask(chatId, null);
        const tasks = await getActiveTasks();
        if (tasks.length === 0) {
          await sendTelegramMessage(
            chatId,
            "📋 <b>No tasks created yet!</b>\nType /addtask to create your first routine."
          );
          return NextResponse.json({ ok: true });
        }

        const taskButtons = await buildTaskListButtons(tasks, true);
        taskButtons.push([{ text: "📋 See All Tasks", callback_data: "menu_alltasks" }]);

        if (taskButtons.length === 1) {
          // Only the "See All Tasks" button exists
          await respondUi(
            chatId,
            messageId,
            "💤 <b>No tasks scheduled for today.</b>\n<i>Your other tasks are set for different days.</i>",
            taskButtons
          );
        } else {
          const { long: dayLong } = localWeekday();
          const tasksText = `📋 <b>Today's Tasks</b> <i>(${dayLong})</i>:\nTap a task to log or start:`;
          await respondUi(chatId, messageId, tasksText, taskButtons);
        }
        return NextResponse.json({ ok: true });
      }

      // --- Button: Show All Tasks List (All Days) ---
      if (callbackData === "menu_alltasks") {
        await clearWizardSession(chatId);
        await setActiveTask(chatId, null);
        const tasks = await getActiveTasks();
        if (tasks.length === 0) {
          await sendTelegramMessage(
            chatId,
            "📋 <b>No tasks created yet!</b>\nType /addtask to create your first routine."
          );
          return NextResponse.json({ ok: true });
        }

        const taskButtons = await buildTaskListButtons(tasks, false);
        taskButtons.push([{ text: "📅 Today's Tasks Only", callback_data: "menu_tasks" }]);
        const tasksText = "📋 <b>All Tasks</b> <i>(all days)</i>:\nTap a task to log or start:";
        await respondUi(chatId, messageId, tasksText, taskButtons);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Open Task from a reminder (fresh message at the bottom) ---
      if (callbackData.startsWith("open_task:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        if (!task) {
          await respondUi(chatId, messageId, "⚠️ Task not found or already archived.", []);
          return NextResponse.json({ ok: true });
        }

        await openTaskScreen(chatId, messageId, task, { fresh: true });
        return NextResponse.json({ ok: true });
      }

      // --- Button: Selected a Task (Clean, Dedicated Actions) ---
      if (callbackData.startsWith("select_task:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        if (!task) {
          await respondUi(chatId, messageId, "⚠️ Task not found or already archived.", []);
          return NextResponse.json({ ok: true });
        }

        await openTaskScreen(chatId, messageId, task, { fresh: false });
        return NextResponse.json({ ok: true });
      }

      // --- Button: Delete Task (Soft delete, past logs are preserved) ---
      if (callbackData.startsWith("delete_task:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        if (!task) {
          await sendTelegramMessage(chatId, "⚠️ Task not found or already deleted.");
          return NextResponse.json({ ok: true });
        }

        if (isSystemTask(task)) {
          await respondUi(
            chatId,
            messageId,
            `🔒 <b>${task.name}</b> is a system task and cannot be deleted.`,
            [[{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }]]
          );
          return NextResponse.json({ ok: true });
        }

        const confirmKb: InlineKeyboard = [
          [{ text: "🗑️ Yes, Delete", callback_data: `confirm_delete:${task.id}` }],
          [{ text: "❌ Cancel", callback_data: `delete_cancel:${task.id}` }],
        ];
        const text =
          `🗑️ <b>Delete "${task.name}"?</b>\n\n` +
          `It will be removed from your task list.\n` +
          `📜 Past logs stay saved forever.`;

        await respondUi(chatId, messageId, text, confirmKb);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Cancel Delete ---
      if (callbackData.startsWith("delete_cancel:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        const text = task
          ? `❌ <i>Delete cancelled — <b>${task.name}</b> is safe.</i>`
          : `❌ <i>Delete cancelled.</i>`;
        await respondUi(chatId, messageId, text, [
          [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
        ]);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Confirm Delete ---
      if (callbackData.startsWith("confirm_delete:")) {
        await setActiveTask(chatId, null);
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        if (!task) {
          await sendTelegramMessage(chatId, "⚠️ Task already deleted.");
          return NextResponse.json({ ok: true });
        }

        if (isSystemTask(task)) {
          await respondUi(
            chatId,
            messageId,
            `🔒 <b>${task.name}</b> is a system task and cannot be deleted.`,
            [[{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }]]
          );
          return NextResponse.json({ ok: true });
        }

        await archiveTask(task.id);

        const text =
          `🗑️ <b>${task.name}</b> removed from your task list.\n\n` +
          `📜 Past logs are untouched — your history is safe.\n` +
          `💡 Create a task with the same name anytime to revive it.`;
        const kb: InlineKeyboard = [[{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }]];

        await respondUi(chatId, messageId, text, kb);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Edit Task Menu ---
      if (callbackData.startsWith("edit_task:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        if (!task) {
          await sendTelegramMessage(chatId, "⚠️ Task not found.");
          return NextResponse.json({ ok: true });
        }

        const firstRow = isSystemTask(task)
          ? []
          : [{ text: "📝 Name", callback_data: `edit_field:${task.id}:name` }];
        if (task.type !== "tick") {
          firstRow.push({ text: "🎯 Goal", callback_data: `edit_field:${task.id}:goal` });
        }
        const isTimer = task.type === "timer" && !isSystemTask(task);
        const pomodoroBtnText = task.is_pomodoro
          ? `🍅 Pomodoro: ON (${task.pomodoro_work_mins || 25}m / ${task.pomodoro_break_mins || 5}m)`
          : `🍅 Pomodoro: OFF`;
        const editKb: InlineKeyboard = [
          firstRow,
          [
            { text: "⏰ Reminder", callback_data: `edit_field:${task.id}:reminder` },
            { text: "📅 Days", callback_data: `edit_field:${task.id}:days` },
          ],
          ...(isTimer
            ? [
                [{
                  text: task.is_project_based ? "📦 Project Mode: ON (Tap to Disable)" : "📦 Project Mode: OFF (Tap to Enable)",
                  callback_data: `toggle_project_based:${task.id}`,
                }],
                [{
                  text: pomodoroBtnText,
                  callback_data: `menu_pomodoro:${task.id}`,
                }],
              ]
            : []),
          [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
        ];

        const text =
          `📝 <b>Edit "${task.name}"</b>\n\n` +
          `${buildTaskSummary(task)}\n\n` +
          `What would you like to change?`;

        await respondUi(chatId, messageId, text, editKb);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Toggle Project-Based Mode for Timer Task ---
      if (callbackData.startsWith("toggle_project_based:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        if (!task) {
          await respondUi(chatId, messageId, "⚠️ Task not found.", []);
          return NextResponse.json({ ok: true });
        }

        const newState = !task.is_project_based;
        await updateTask(taskId, { is_project_based: newState });
        const updatedTask = { ...task, is_project_based: newState };

        const firstRow = isSystemTask(updatedTask)
          ? []
          : [{ text: "📝 Name", callback_data: `edit_field:${updatedTask.id}:name` }];
        if (updatedTask.type !== "tick") {
          firstRow.push({ text: "🎯 Goal", callback_data: `edit_field:${updatedTask.id}:goal` });
        }
        const isTimer = updatedTask.type === "timer" && !isSystemTask(updatedTask);
        const pomodoroBtnText = updatedTask.is_pomodoro
          ? `🍅 Pomodoro: ON (${updatedTask.pomodoro_work_mins || 25}m / ${updatedTask.pomodoro_break_mins || 5}m)`
          : `🍅 Pomodoro: OFF`;
        const editKb: InlineKeyboard = [
          firstRow,
          [
            { text: "⏰ Reminder", callback_data: `edit_field:${updatedTask.id}:reminder` },
            { text: "📅 Days", callback_data: `edit_field:${updatedTask.id}:days` },
          ],
          ...(isTimer
            ? [
                [{
                  text: newState ? "📦 Project Mode: ON (Tap to Disable)" : "📦 Project Mode: OFF (Tap to Enable)",
                  callback_data: `toggle_project_based:${updatedTask.id}`,
                }],
                [{
                  text: pomodoroBtnText,
                  callback_data: `menu_pomodoro:${updatedTask.id}`,
                }],
              ]
            : []),
          [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
        ];

        const text =
          `📝 <b>Edit "${updatedTask.name}"</b>\n\n` +
          `${buildTaskSummary(updatedTask)}\n\n` +
          `✅ <i>Project mode ${newState ? "enabled" : "disabled"}!</i>\n` +
          `What else would you like to change?`;

        await respondUi(chatId, messageId, text, editKb);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Pomodoro Settings Menu ---
      if (callbackData.startsWith("menu_pomodoro:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        if (!task) {
          await respondUi(chatId, messageId, "⚠️ Task not found.", []);
          return NextResponse.json({ ok: true });
        }

        const statusLine = task.is_pomodoro
          ? `✅ <b>Status: ON</b> (${task.pomodoro_work_mins || 25}m focus / ${task.pomodoro_break_mins || 5}m break)`
          : `⚪ <b>Status: OFF</b> (Normal continuous stopwatch)`;

        const text =
          `🍅 <b>Pomodoro Settings for "${task.name}"</b>\n\n` +
          `${statusLine}\n\n` +
          `When enabled, the timer will automatically:\n` +
          `• Count down your focus session\n` +
          `• Auto-pause and chime when focus ends\n` +
          `• Guide you through a restful break (excluded from study time)\n` +
          `• Sound an alarm when break ends\n\n` +
          `Choose an interval preset or toggle:`;

        const kb: InlineKeyboard = [
          [
            { text: "🍅 25m Focus / 5m Break", callback_data: `set_pomodoro:${task.id}:25:5` },
          ],
          [
            { text: "🍅 50m Focus / 10m Break", callback_data: `set_pomodoro:${task.id}:50:10` },
          ],
          [
            { text: "✏️ Custom Intervals", callback_data: `set_pomodoro:${task.id}:custom` },
          ],
          ...(task.is_pomodoro
            ? [[{ text: "❌ Turn OFF Pomodoro", callback_data: `set_pomodoro:${task.id}:off` }]]
            : [[{ text: "✅ Turn ON (25m / 5m)", callback_data: `set_pomodoro:${task.id}:25:5` }]]),
          [{ text: "↩️ Back to Edit Task", callback_data: `edit_task:${task.id}` }],
        ];

        await respondUi(chatId, messageId, text, kb);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Apply Pomodoro Preset / Toggle ---
      if (callbackData.startsWith("set_pomodoro:")) {
        const parts = callbackData.split(":");
        const taskId = parts[1];
        const action = parts[2];
        const task = await getTaskById(taskId);
        if (!task) {
          await respondUi(chatId, messageId, "⚠️ Task not found.", []);
          return NextResponse.json({ ok: true });
        }

        if (action === "off") {
          await updateTask(taskId, { is_pomodoro: false });
          await respondUi(
            chatId,
            messageId,
            `🍅 <b>Pomodoro Mode Disabled for "${task.name}"</b>\n\n` +
              `It will now run as a normal continuous stopwatch.`,
            [[{ text: "↩️ Back to Edit Task", callback_data: `edit_task:${taskId}` }]]
          );
          return NextResponse.json({ ok: true });
        }

        if (action === "custom") {
          await saveWizardSession(chatId, "awaiting_edit_pomodoro_work", {
            taskId,
            taskName: task.name,
            promptMessageId: messageId,
          });
          await respondUi(
            chatId,
            messageId,
            `🍅 <b>Custom Pomodoro for "${task.name}"</b>\n\n` +
              `How many minutes of focus work per round?\n` +
              `<i>(e.g., 20, 25, 30, 45, 60)</i>`,
            [[{ text: "❌ Cancel", callback_data: `menu_pomodoro:${taskId}` }]]
          );
          return NextResponse.json({ ok: true });
        }

        const workMins = parseInt(parts[2], 10) || 25;
        const breakMins = parseInt(parts[3], 10) || 5;

        await updateTask(taskId, {
          is_pomodoro: true,
          pomodoro_work_mins: workMins,
          pomodoro_break_mins: breakMins,
        });

        await respondUi(
          chatId,
          messageId,
          `🍅 <b>Pomodoro Enabled for "${task.name}"!</b>\n\n` +
            `🎯 Focus: <b>${workMins} minutes</b>\n` +
            `☕ Break: <b>${breakMins} minutes</b>\n\n` +
            `Whenever you start this task, it will run in Pomodoro mode automatically.`,
          [
            [{ text: "⚙️ Pomodoro Settings", callback_data: `menu_pomodoro:${taskId}` }],
            [{ text: "↩️ Back to Edit Task", callback_data: `edit_task:${taskId}` }],
          ]
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Send Test / Immediate Summary Email ---
      if (callbackData === "send_test_email") {
        if (body.callback_query?.id) {
          await answerCallbackQuery(body.callback_query.id, "Generating and sending email summary...");
        }
        const userSettings = await getUserSettings(chatId);
        const recipient = userSettings.summary_email_to || process.env.SUMMARY_EMAIL_TO;
        const result = await sendDailySummaryEmail(undefined, recipient || undefined);
        if (result.sent) {
          await sendTelegramMessage(
            chatId,
            `📧 <b>Daily Summary Sent!</b>\n\n` +
            `Delivered yesterday's debrief to <code>${recipient}</code> via <b>${result.provider}</b>.\n` +
            `• Focus time: <b>${result.summary ? formatTimerMinutes(result.summary.totalFocusMin) : "N/A"}</b>\n` +
            `• Completed items: <b>${result.summary ? result.summary.completedTodos.length : 0}</b>\n` +
            `• Incomplete items: <b>${result.summary ? result.summary.incompleteTodos.length : 0}</b>`
          );
        } else {
          await sendTelegramMessage(
            chatId,
            `⚠️ <b>Email Delivery Failed:</b>\n${result.error || result.reason}\n\n` +
            `You can update your email anytime right here in <b>/settings</b> → [✏️ Change Email]!`
          );
        }
        return NextResponse.json({ ok: true });
      }

      // --- Button: Change Daily Summary Email ---
      if (callbackData === "set_summary_email") {
        await saveWizardSession(chatId, "awaiting_settings_email", {
          promptMessageId: messageId,
        });
        const userSettings = await getUserSettings(chatId);
        const currentEmail = userSettings.summary_email_to || process.env.SUMMARY_EMAIL_TO || "None";
        await respondUi(
          chatId,
          messageId,
          `✉️ <b>Change Daily Summary Email</b>\n\n` +
          `Current recipient: <code>${currentEmail}</code>\n\n` +
          `Please reply with your new email address as a chat message (e.g. <code>name@example.com</code>).\n\n` +
          `<i>Type /cancel to keep your current email.</i>`,
          [[{ text: "↩️ Cancel", callback_data: "menu_settings" }]]
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Show Settings Menu ---
      if (callbackData === "menu_settings" || callbackData === "menu_settings_idle") {
        await clearWizardSession(chatId);
        await setActiveTask(chatId, null);
        const view = await buildSettingsView(chatId);
        await respondUi(chatId, messageId, view.text, view.keyboard);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Toggle Idle Guardian (ON / OFF) ---
      if (callbackData === "toggle_idle_guardian") {
        const current = await getUserSettings(chatId);
        const newState = !current.idle_nudge_enabled;
        await updateUserSettings(chatId, {
          idle_nudge_enabled: newState,
          last_idle_nudge_at: new Date().toISOString(),
        });
        const view = await buildSettingsView(chatId);
        await respondUi(chatId, messageId, view.text, view.keyboard);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Set Idle Interval ---
      if (callbackData.startsWith("set_idle_interval:")) {
        const value = callbackData.split(":")[1];
        if (value === "custom") {
          await saveWizardSession(chatId, "awaiting_settings_interval", {
            promptMessageId: messageId,
          });
          await respondUi(
            chatId,
            messageId,
            `⏱️ <b>Custom Idle Alert Interval</b>\n\n` +
              `How many minutes of idle time before the 4-beep alert?\n` +
              `<i>(e.g., 3, 5, 10, 15, 20)</i>`,
            [[{ text: "❌ Cancel", callback_data: "menu_settings" }]]
          );
          return NextResponse.json({ ok: true });
        }

        const mins = parseInt(value, 10) || 3;
        await updateUserSettings(chatId, {
          idle_interval_mins: mins,
          last_idle_nudge_at: new Date().toISOString(),
        });
        const view = await buildSettingsView(chatId);
        await respondUi(chatId, messageId, view.text, view.keyboard);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Set Idle Active Window ---
      if (callbackData.startsWith("set_idle_window:")) {
        const parts = callbackData.split(":");
        if (parts[1] === "custom") {
          await saveWizardSession(chatId, "awaiting_settings_window", {
            promptMessageId: messageId,
          });
          await respondUi(
            chatId,
            messageId,
            `⏰ <b>Custom Active Hours Window</b>\n\n` +
              `Enter start and end time (e.g. <b>05:00 to 22:00</b> or <b>6am to 11pm</b>):`,
            [[{ text: "❌ Cancel", callback_data: "menu_settings" }]]
          );
          return NextResponse.json({ ok: true });
        }

        const start = parts[1];
        const end = parts[2];
        await updateUserSettings(chatId, {
          idle_window_start: start,
          idle_window_end: end,
          last_idle_nudge_at: new Date().toISOString(),
        });
        const view = await buildSettingsView(chatId);
        await respondUi(chatId, messageId, view.text, view.keyboard);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Idle Snooze ---
      if (callbackData.startsWith("idle_snooze:")) {
        const mins = parseInt(callbackData.split(":")[1], 10) || 30;
        const snoozeUntil = new Date(Date.now() + mins * 60 * 1000).toISOString();
        await updateUserSettings(chatId, { idle_snoozed_until: snoozeUntil });
        await respondUi(
          chatId,
          messageId,
          `⏸️ <b>Idle Guardian Snoozed for ${mins} minutes!</b>\n\n` +
            `Take your time for lunch/break. No idle alerts will ring until then.`,
          [
            [{ text: "▶️ Cancel Snooze", callback_data: "idle_unsnooze" }],
            [{ text: "⚙️ Settings", callback_data: "menu_settings" }],
          ]
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Cancel Snooze ---
      if (callbackData === "idle_unsnooze") {
        await updateUserSettings(chatId, {
          idle_snoozed_until: null,
          last_idle_nudge_at: new Date().toISOString(),
        });
        const view = await buildSettingsView(chatId);
        await respondUi(chatId, messageId, view.text, view.keyboard);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Manage Task (from /edit list) -> Edit or Delete ---
      if (callbackData.startsWith("manage_task:")) {
        await setActiveTask(chatId, null);
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        if (!task) {
          await respondUi(chatId, messageId, "⚠️ Task not found or already deleted.", []);
          return NextResponse.json({ ok: true });
        }

        const manageKb: InlineKeyboard = [
          [
            { text: "📝 Edit", callback_data: `edit_task:${task.id}` },
            ...(isSystemTask(task)
              ? []
              : [{ text: "🗑️ Delete", callback_data: `delete_task:${task.id}` }]),
          ],
          [{ text: "↩️ Back to Task List", callback_data: "ui_edit_list" }],
        ];

        await respondUi(
          chatId,
          messageId,
          `⚙️ <b>${task.name}</b>\n\n${buildTaskSummary(task)}\n\nWhat do you want to do?`,
          manageKb
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Re-render the /edit Task List ---
      if (callbackData === "ui_edit_list") {
        await setActiveTask(chatId, null);
        const tasks = await getActiveTasks();
        if (tasks.length === 0) {
          await respondUi(chatId, messageId, "📋 <b>No tasks to edit yet!</b>", []);
          return NextResponse.json({ ok: true });
        }

        const listKb: InlineKeyboard = tasks.map((t) => [
          {
            text: `${taskEmoji(t)} ${t.name}`,
            callback_data: `manage_task:${t.id}`,
          },
        ]);

        await respondUi(chatId, messageId, "✏️ <b>Edit Tasks</b>\nTap a task to edit or delete:", listKb);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Edit a Specific Field ---
      if (callbackData.startsWith("edit_field:")) {
        const [, taskId, field] = callbackData.split(":");
        const task = await getTaskById(taskId);
        if (!task) {
          await sendTelegramMessage(chatId, "⚠️ Task not found.");
          return NextResponse.json({ ok: true });
        }

        if (field === "name" && isSystemTask(task)) {
          await respondUi(
            chatId,
            messageId,
            `🔒 <b>${task.name}</b> is a system task — its name cannot be changed.`,
            [[{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }]]
          );
          return NextResponse.json({ ok: true });
        }

        if (field === "name") {
          await sendWizardPrompt(
            chatId,
            "awaiting_edit_name",
            { taskId: task.id, name: task.name },
            `📝 <b>New name for "${task.name}"</b>\n\nSend the new name:`,
            [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]],
            messageId
          );
        } else if (field === "goal") {
          const prompt =
            task.type === "timer"
              ? `🎯 <b>New goal for "${task.name}"</b>\n\nSend the daily time goal:\n<i>(e.g., "2 hours", "1h 30m", "45 mins")</i>`
              : `🎯 <b>New goal for "${task.name}"</b>\n\nSend the goal & unit:\n<i>(e.g., "5000 ml", "10 km", "50 pages")</i>`;
          await sendWizardPrompt(
            chatId,
            "awaiting_edit_goal",
            { taskId: task.id, name: task.name },
            prompt,
            [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]],
            messageId
          );
        } else if (field === "reminder") {
          await sendWizardPrompt(
            chatId,
            "awaiting_edit_reminder",
            { taskId: task.id, name: task.name },
            `⏰ <b>New reminder for "${task.name}"</b>\n\n` +
              `Current: <b>${formatReminderTime(task.reminder_time)}</b>\n\n` +
              `Send the new time:\n<i>(e.g., "8am", "18:30")</i>`,
            [
              [{ text: "⏭️ Remove Reminder", callback_data: `edit_clear_reminder:${task.id}` }],
              [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
            ],
            messageId
          );
        } else if (field === "days") {
          await sendWizardPrompt(
            chatId,
            "awaiting_edit_days",
            { taskId: task.id, name: task.name },
            `📅 <b>New days for "${task.name}"</b>\n\n` +
              `Current: <b>${formatScheduleDisplay(getTaskSchedule(task))}</b>\n\n` +
              `Tap Daily, or type the days:\n<i>(e.g., "Mon, Wed, Fri")</i>`,
            [
              [{ text: "🌟 Daily (Every Day)", callback_data: `edit_set_days:${task.id}:daily` }],
              [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
            ],
            messageId
          );
        } else {
          await sendTelegramMessage(chatId, "⚠️ Unknown edit option.");
        }
        return NextResponse.json({ ok: true });
      }

      // --- Button: Remove Reminder (from edit prompt) ---
      if (callbackData.startsWith("edit_clear_reminder:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        if (!task) {
          await sendTelegramMessage(chatId, "⚠️ Task not found.");
          return NextResponse.json({ ok: true });
        }

        const updated = await updateTask(task.id, { reminder_time: null });
        const promptId = (await getWizardSession(chatId))?.task_data?.promptMessageId;
        await clearWizardSession(chatId);

        const text = updated
          ? `⏰ Reminder removed for <b>${task.name}</b>.\n\n${buildTaskSummary(updated)}`
          : `⚠️ Could not update the task. Please try again.`;
        await respondUi(chatId, messageId, text, [
          [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
        ]);
        if (promptId && promptId !== messageId) {
          await removeInlineKeyboard(chatId, promptId);
        }
        return NextResponse.json({ ok: true });
      }

      // --- Button: Set Days to Daily (from edit prompt) ---
      if (callbackData.startsWith("edit_set_days:")) {
        const [, taskId] = callbackData.split(":");
        const task = await getTaskById(taskId);
        if (!task) {
          await sendTelegramMessage(chatId, "⚠️ Task not found.");
          return NextResponse.json({ ok: true });
        }

        const updated = await updateTask(task.id, { target_days: "daily" });
        const promptId = (await getWizardSession(chatId))?.task_data?.promptMessageId;
        await clearWizardSession(chatId);

        const text = updated
          ? `📅 Schedule updated to Daily for <b>${task.name}</b>.\n\n${buildTaskSummary(updated)}`
          : `⚠️ Could not update the task. Please try again.`;
        await respondUi(chatId, messageId, text, [
          [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
        ]);
        if (promptId && promptId !== messageId) {
          await removeInlineKeyboard(chatId, promptId);
        }
        return NextResponse.json({ ok: true });
      }

      // --- Button: Quick Add Minutes to Timer Task ---
      if (callbackData.startsWith("timer_add:")) {
        const [, taskId, minsStr] = callbackData.split(":");
        const mins = parseInt(minsStr, 10);
        const task = await getTaskById(taskId);
        const taskName = task ? task.name : "Study/Work";
        const target = task?.target_value || 60;

        const newLog = await logActivity({
          task_id: taskId,
          task_name: taskName,
          value: mins,
          notes: `Manual log +${mins}m`,
        });

        const newTotal = await getTodayTaskTotal(taskName);
        const percent = Math.round((newTotal / target) * 100);

        const showFocus = !!newLog?.id && !isSystemTask(task);
        const replyKb: InlineKeyboard = showFocus
          ? buildReviewKeyboard(newLog!.id as string)
          : BACK_ONLY_KEYBOARD;

        const text =
          `${task ? taskEmoji(task) : "⏱️"} <b>+${formatTimerMinutes(mins)} logged for ${taskName}!</b>\n\n` +
          `📊 Today's Total: <b>${newTotal} / ${target} mins</b> (${percent}% of daily goal)` +
          (showFocus ? FOCUS_QUESTION : "");

        await respondUi(chatId, messageId, text, replyKb);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Prompt for Custom Minutes ---
      if (callbackData.startsWith("timer_custom_prompt:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        if (!task) {
          await sendTelegramMessage(chatId, "⚠️ Task not found.");
          return NextResponse.json({ ok: true });
        }

        await sendWizardPrompt(
          chatId,
          "awaiting_timer_custom",
          {
            taskId: task.id,
            name: task.name,
            target_value: task.target_value,
          },
          `✏️ <b>Log Custom Minutes for ${task.name}</b>\n\n` +
            `How many minutes did you spend?\n` +
            `<i>(e.g., 25, 45, 90, 150)</i>`,
          [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]]
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Start Timer (live stopwatch) ---
      if (callbackData.startsWith("start_task:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        const taskName = task ? task.name : "Study/Work";

        // Never silently discard a running session — ask to stop it first
        const alreadyRunning = await getActiveTimer(chatId);
        if (alreadyRunning) {
          const warnKb: InlineKeyboard = [
            [{ text: `⏹ Stop ${alreadyRunning.task_name}`, callback_data: "stop_active_timer" }],
            [{ text: `▶️ Start ${taskName}`, callback_data: `start_task:${taskId}` }],
          ];
          await respondUi(
            chatId,
            messageId,
            `⚠️ <b>${alreadyRunning.task_name}</b> is already running.\n\n` +
              `Stop & log it first, then start <b>${taskName}</b>:`,
            warnKb
          );
          return NextResponse.json({ ok: true });
        }

        // If the task is project-based, check for ongoing project or ask for new project
        if (task?.is_project_based) {
          const activeProject = await getActiveProjectForTask(taskId);
          if (activeProject) {
            const projLabel =
              activeProject.name.length > 25 ? activeProject.name.slice(0, 25) + "…" : activeProject.name;
            const kb: InlineKeyboard = [
              [{ text: `▶️ Continue "${projLabel}"`, callback_data: `start_proj:${activeProject.id}` }],
              [{ text: `➕ Start New Project`, callback_data: `new_proj:${taskId}` }],
              [{ text: `📋 Back to Tasks`, callback_data: "menu_tasks" }],
            ];
            await respondUi(
              chatId,
              messageId,
              `📦 <b>${taskName}</b> is a project-based task.\n\n` +
                `Active Project: <b>${activeProject.name}</b>\n\n` +
                `Would you like to continue this project or start a new one?`,
              kb
            );
            return NextResponse.json({ ok: true });
          }

          // No active project: ask for project name
          await saveWizardSession(chatId, "awaiting_project_name", {
            taskId: task.id,
            taskName: task.name,
            promptMessageId: messageId,
          });
          await respondUi(
            chatId,
            messageId,
            `📦 <b>${taskName}</b> is a project-based task.\n\n` +
              `What project are you working on?\n` +
              `<i>(e.g., Making PPT for Optics, Chapter 4 Notes, Problem Set 3)</i>`,
            [[{ text: "❌ Cancel", callback_data: `open_task:${taskId}` }]]
          );
          return NextResponse.json({ ok: true });
        }

        await promptOrStartTimer(chatId, messageId, taskId, taskName, null, null);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Start Timer with Existing Project ---
      if (callbackData.startsWith("start_proj:") || callbackData.startsWith("start_task_project:")) {
        const parts = callbackData.split(":");
        const projectId = parts.length === 3 ? parts[2] : parts[1];
        const project = await getProjectById(projectId);
        const taskId = project?.task_id || (parts.length === 3 ? parts[1] : "");
        const task = await getTaskById(taskId);
        const taskName = task ? task.name : "Study/Work";
        const projectName = project ? project.name : null;

        await promptOrStartTimer(chatId, messageId, taskId, taskName, projectId, projectName);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Prompt New Project for Project-Based Task ---
      if (callbackData.startsWith("new_proj:") || callbackData.startsWith("prompt_new_project:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        const taskName = task ? task.name : "Study/Work";

        const oldActive = await getActiveProjectForTask(taskId);
        if (oldActive) {
          // Check if previous project has pending unfinished to-dos
          const pendingTodos = await getPendingTodosForProject(oldActive.id);
          if (pendingTodos.length > 0) {
            await saveWizardSession(chatId, "awaiting_project_todos_resolution", {
              taskId,
              taskName,
              projectId: oldActive.id,
              projectName: oldActive.name,
              pastTodoIds: pendingTodos.map((t) => t.id),
              promptMessageId: messageId,
            });

            const taskList = pendingTodos.map((t, idx) => `${idx + 1}. ${t.title}`).join("\n");
            const kb: InlineKeyboard = [
              [{ text: `✅ Mark All Done (${pendingTodos.length})`, callback_data: `proj_todos_act:done` }],
              [{ text: `📥 Move to New Project (${pendingTodos.length})`, callback_data: `proj_todos_act:move` }],
              [{ text: `📦 Archive as Incomplete (${pendingTodos.length})`, callback_data: `proj_todos_act:archive` }],
              [{ text: "❌ Cancel", callback_data: `open_task:${taskId}` }],
            ];

            await respondUi(
              chatId,
              messageId,
              `📦 Previous project <b>"${oldActive.name}"</b> has <b>${pendingTodos.length}</b> unfinished task${pendingTodos.length > 1 ? "s" : ""}:\n\n` +
                `${taskList}\n\n` +
                `What would you like to do with them before starting the new project?`,
              kb
            );
            return NextResponse.json({ ok: true });
          }

          // No pending to-dos: auto-complete previous project
          await markProjectCompleted(oldActive.id);
        }

        await saveWizardSession(chatId, "awaiting_project_name", {
          taskId,
          taskName,
          promptMessageId: messageId,
        });

        await respondUi(
          chatId,
          messageId,
          `📦 <b>New Project for ${taskName}</b>\n\n` +
            (oldActive ? `<i>Previous project "${oldActive.name}" has been marked complete.</i>\n\n` : "") +
            `What is the name of your new project?\n` +
            `<i>(e.g., Making PPT for Optics, Chapter 4 Notes, Problem Set 3)</i>`,
          [[{ text: "❌ Cancel", callback_data: `open_task:${taskId}` }]]
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Resolve Pending To-Dos from Previous Project ---
      if (callbackData.startsWith("proj_todos_act:")) {
        const action = callbackData.split(":")[1];
        const session = await getWizardSession(chatId);
        if (!session || !session.task_data.taskId || !session.task_data.projectId) {
          await respondUi(chatId, messageId, "⚠️ Session expired. Please open the task again.", []);
          return NextResponse.json({ ok: true });
        }

        const { taskId, taskName, projectId, projectName, pastTodoIds } = session.task_data;
        const todoIds = pastTodoIds || [];

        let actionNotice = "";
        let transferIds: string[] | undefined = undefined;

        if (action === "done") {
          await markProjectTodosDone(todoIds);
          actionNotice = `<i>All ${todoIds.length} tasks from "${projectName}" marked completed.</i>\n\n`;
        } else if (action === "archive") {
          await archiveProjectTodos(todoIds);
          actionNotice = `<i>All ${todoIds.length} tasks from "${projectName}" archived as incomplete.</i>\n\n`;
        } else if (action === "move") {
          transferIds = todoIds;
          actionNotice = `<i>${todoIds.length} tasks will be transferred to your new project.</i>\n\n`;
        }

        // Mark old project completed
        await markProjectCompleted(projectId);

        // Transition to asking for new project name
        await saveWizardSession(chatId, "awaiting_project_name", {
          taskId,
          taskName,
          transferTodoIds: transferIds,
          promptMessageId: messageId,
        });

        await respondUi(
          chatId,
          messageId,
          `📦 <b>New Project for ${taskName || "Study/Work"}</b>\n\n` +
            actionNotice +
            `<i>Previous project "${projectName}" has been marked complete.</i>\n\n` +
            `What is the name of your new project?\n` +
            `<i>(e.g., Making PPT for Optics, Chapter 4 Notes, Problem Set 3)</i>`,
          [[{ text: "❌ Cancel", callback_data: `open_task:${taskId}` }]]
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Project Target Goal (Quick Buttons or Skip) ---
      if (callbackData.startsWith("project_target:")) {
        const val = callbackData.split(":")[1];
        const targetMinutes = val === "skip" ? null : parseInt(val, 10) || null;
        const session = await getWizardSession(chatId);
        if (!session || !session.task_data.projectName) {
          await sendTelegramMessage(chatId, "⚠️ Session expired. Please open the task again.");
          return NextResponse.json({ ok: true });
        }

        const taskData = session.task_data;
        const descKb: InlineKeyboard = [
          [{ text: "▶️ Start Timer Now (Skip Note)", callback_data: "project_desc:skip" }],
          [{ text: "❌ Cancel", callback_data: `open_task:${taskData.taskId}` }],
        ];

        await sendWizardPrompt(
          chatId,
          "awaiting_project_description",
          {
            ...taskData,
            projectTargetMinutes: targetMinutes,
          },
          `📝 <b>Project Description / Outline (Optional)</b>\n\n` +
            `Project: <b>${taskData.projectName}</b>\n` +
            (targetMinutes ? `Goal: <b>${formatTimerMinutes(targetMinutes)}</b>\n\n` : "\n") +
            `Type a short note or checklist for this project (e.g. <i>"Cover formulas and 10 questions"</i>):\n\n` +
            `— <b>OR tap Start Timer to begin right away:</b>`,
          descKb,
          messageId
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Project Description Skip -> Create & Start ---
      if (callbackData === "project_desc:skip") {
        const session = await getWizardSession(chatId);
        if (!session || !session.task_data.projectName || !session.task_data.taskId) {
          await sendTelegramMessage(chatId, "⚠️ Session expired. Please open the task again.");
          return NextResponse.json({ ok: true });
        }

        const taskData = session.task_data;
        const taskId = taskData.taskId!;
        const taskName = taskData.taskName || "Study/Work";
        const projectName = taskData.projectName!;
        const targetMinutes = taskData.projectTargetMinutes ?? null;

        const project = await createProject(taskId, projectName, targetMinutes, null);
        if (project && taskData.transferTodoIds && taskData.transferTodoIds.length > 0) {
          const today = localDateString();
          await transferTodosToProject(taskData.transferTodoIds, project.id, today);
        }
        await clearWizardSession(chatId);

        await promptOrStartTimer(chatId, messageId, taskId, taskName, project?.id || null, project?.name || projectName);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Apply Carry-Over of Past Incomplete To-Dos ---
      if (callbackData === "carryover_apply") {
        const session = await getWizardSession(chatId);
        if (!session || !session.task_data.taskId) {
          await respondUi(chatId, messageId, "⚠️ Session expired. Please open the task again.", []);
          return NextResponse.json({ ok: true });
        }

        const { taskId, taskName, projectId, projectName, pastTodoIds } = session.task_data;
        const today = localDateString();

        if (pastTodoIds && pastTodoIds.length > 0) {
          await carryOverTodosToToday(pastTodoIds, today);
        }

        const todos = projectId
          ? await getDailyTodosForProject(projectId, today)
          : await getDailyTodosForTask(taskId, today);

        await saveWizardSession(chatId, "awaiting_daily_todo_input", {
          taskId,
          taskName,
          projectId,
          projectName,
          promptMessageId: messageId,
        });

        const projectTag = projectName ? `📦 Project: <b>${projectName}</b>\n` : "";
        const listText = todos.map((t, idx) => `${idx + 1}. ${t.title}`).join("\n");

        const startLabel =
          todos.length === 1
            ? `▶️ Start Timer (1 task)`
            : `▶️ Done / Start Timer (${todos.length} tasks)`;

        const kb: InlineKeyboard = [
          [{ text: startLabel, callback_data: "daily_todo_done" }],
          [{ text: "❌ Cancel", callback_data: `open_task:${taskId}` }],
        ];

        await respondUi(
          chatId,
          messageId,
          `${projectTag}📋 <b>Today's Plan (Carried Over):</b>\n\n` +
            `${listText}\n\n` +
            `Send more tasks to add (one by one or comma-separated), or tap <b>Done / Start Timer</b> below:`,
          kb
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Start Fresh / New Tasks (Leave Past To-Dos untouched) ---
      if (callbackData === "carryover_fresh") {
        const session = await getWizardSession(chatId);
        if (!session || !session.task_data.taskId) {
          await respondUi(chatId, messageId, "⚠️ Session expired. Please open the task again.", []);
          return NextResponse.json({ ok: true });
        }

        const { taskId, taskName, projectId, projectName } = session.task_data;

        await saveWizardSession(chatId, "awaiting_daily_todo_input", {
          taskId,
          taskName,
          projectId,
          projectName,
          promptMessageId: messageId,
        });

        const projectTag = projectName ? `📦 Project: <b>${projectName}</b>\n\n` : "";
        const kb: InlineKeyboard = [
          [{ text: "▶️ Start Timer (Leave Blank)", callback_data: "daily_todo_skip" }],
          [{ text: "❌ Cancel", callback_data: `open_task:${taskId}` }],
        ];

        await respondUi(
          chatId,
          messageId,
          `${projectTag}📋 <b>What tasks/work will you do today for ${projectName || taskName}?</b>\n\n` +
            `Send your tasks one by one or separated by commas:\n` +
            `<i>(e.g., "Read Snell's Law, Numericals 1-10, Formulas")</i>\n\n` +
            `Tap <b>Start Timer</b> below if you prefer to leave it blank:`,
          kb
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Dismiss Past To-Dos (Mark Completed / Inactive) ---
      if (callbackData === "carryover_dismiss") {
        const session = await getWizardSession(chatId);
        if (!session || !session.task_data.taskId) {
          await respondUi(chatId, messageId, "⚠️ Session expired. Please open the task again.", []);
          return NextResponse.json({ ok: true });
        }

        const { taskId, taskName, projectId, projectName, pastTodoIds } = session.task_data;

        if (pastTodoIds && pastTodoIds.length > 0) {
          await dismissPastTodos(pastTodoIds);
        }

        await saveWizardSession(chatId, "awaiting_daily_todo_input", {
          taskId,
          taskName,
          projectId,
          projectName,
          promptMessageId: messageId,
        });

        const projectTag = projectName ? `📦 Project: <b>${projectName}</b>\n\n` : "";
        const kb: InlineKeyboard = [
          [{ text: "▶️ Start Timer (Leave Blank)", callback_data: "daily_todo_skip" }],
          [{ text: "❌ Cancel", callback_data: `open_task:${taskId}` }],
        ];

        await respondUi(
          chatId,
          messageId,
          `${projectTag}🗑️ <i>Past unfinished tasks dismissed.</i>\n\n` +
            `📋 <b>What tasks/work will you do today for ${projectName || taskName}?</b>\n\n` +
            `Send your tasks one by one or separated by commas:\n` +
            `<i>(e.g., "Read Snell's Law, Numericals 1-10, Formulas")</i>\n\n` +
            `Tap <b>Start Timer</b> below if you prefer to leave it blank:`,
          kb
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Daily To-Do Done (Start Timer Directly or Show Pick) ---
      if (callbackData === "daily_todo_done") {
        const session = await getWizardSession(chatId);
        if (!session || !session.task_data.taskId) {
          await respondUi(chatId, messageId, "⚠️ Session expired. Please open the task again.", []);
          return NextResponse.json({ ok: true });
        }

        const { taskId, taskName, projectId, projectName } = session.task_data;
        const today = localDateString();
        const todos = projectId
          ? await getDailyTodosForProject(projectId, today)
          : await getDailyTodosForTask(taskId, today);
        const pending = todos.filter((t) => !t.is_done);

        await clearWizardSession(chatId);

        // If exactly 1 pending task, start timer directly with that task (no extra questions!)
        if (pending.length === 1) {
          await doStartActiveTimer(
            chatId,
            messageId,
            taskId,
            taskName || "Study/Work",
            projectId || null,
            projectName || null,
            pending[0].id,
            pending[0].title
          );
          return NextResponse.json({ ok: true });
        }

        // If no pending tasks (or all completed), start general timer directly
        if (pending.length === 0) {
          await doStartActiveTimer(
            chatId,
            messageId,
            taskId,
            taskName || "Study/Work",
            projectId || null,
            projectName || null,
            null,
            null
          );
          return NextResponse.json({ ok: true });
        }

        // Multiple pending tasks (>= 2): ask which one to start with
        await showSessionTodoPick(
          chatId,
          messageId,
          taskId,
          taskName || "Study/Work",
          projectId || null,
          projectName || null,
          todos
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Back to Session To-Do Pick Menu ---
      if (callbackData === "daily_todo_back") {
        const session = await getWizardSession(chatId);
        if (!session || !session.task_data.taskId) {
          await respondUi(chatId, messageId, "⚠️ Session expired. Please open the task again.", []);
          return NextResponse.json({ ok: true });
        }

        const { taskId, taskName, projectId, projectName } = session.task_data;
        await showSessionTodoPick(
          chatId,
          messageId,
          taskId,
          taskName || "Study/Work",
          projectId || null,
          projectName || null
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Daily To-Do Skip (Leave Blank and Start Timer) ---
      if (callbackData === "daily_todo_skip") {
        const session = await getWizardSession(chatId);
        if (!session || !session.task_data.taskId) {
          await respondUi(chatId, messageId, "⚠️ Session expired. Please open the task again.", []);
          return NextResponse.json({ ok: true });
        }

        const { taskId, taskName, projectId, projectName } = session.task_data;
        await clearWizardSession(chatId);
        await doStartActiveTimer(
          chatId,
          messageId,
          taskId,
          taskName || "Study/Work",
          projectId || null,
          projectName || null,
          null,
          null
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Add More To-Dos from Pick Menu ---
      if (callbackData === "daily_todo_add_more") {
        const session = await getWizardSession(chatId);
        if (!session || !session.task_data.taskId) {
          await respondUi(chatId, messageId, "⚠️ Session expired. Please open the task again.", []);
          return NextResponse.json({ ok: true });
        }

        const { taskId, taskName, projectId, projectName } = session.task_data;
        await saveWizardSession(chatId, "awaiting_daily_todo_input", {
          taskId,
          taskName,
          projectId,
          projectName,
          promptMessageId: messageId,
        });

        const projectTag = projectName ? `📦 Project: <b>${projectName}</b>\n\n` : "";
        const kb: InlineKeyboard = [
          [{ text: "🔙 Back to Task List", callback_data: "daily_todo_back" }],
        ];

        await respondUi(
          chatId,
          messageId,
          `${projectTag}➕ <b>Add tasks to today's plan:</b>\n\n` +
            `Type your tasks (one by one or separated by commas):\n` +
            `<i>(e.g., "Read Snell's Law, Numericals 1-10, Formulas")</i>`,
          kb
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Pick To-Do for Active Session ---
      if (callbackData.startsWith("pick_todo:")) {
        const todoId = callbackData.split(":")[1];
        const todo = await getProjectTodoById(todoId);
        const session = await getWizardSession(chatId);

        const taskId = session?.task_data.taskId || todo?.task_id;
        const taskName = session?.task_data.taskName || "Study/Work";
        const projectId = session?.task_data.projectId || todo?.project_id || null;
        const projectName = session?.task_data.projectName || null;

        if (!taskId) {
          await respondUi(chatId, messageId, "⚠️ Task not found. Please open the task again.", []);
          return NextResponse.json({ ok: true });
        }

        await clearWizardSession(chatId);
        await doStartActiveTimer(
          chatId,
          messageId,
          taskId,
          taskName,
          projectId,
          projectName,
          todo?.id || null,
          todo?.title || null
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Start Session with No Specific To-Do (General) ---
      if (callbackData === "pick_todo_none") {
        const session = await getWizardSession(chatId);
        if (!session || !session.task_data.taskId) {
          await respondUi(chatId, messageId, "⚠️ Session expired. Please open the task again.", []);
          return NextResponse.json({ ok: true });
        }

        const { taskId, taskName, projectId, projectName } = session.task_data;
        await clearWizardSession(chatId);
        await doStartActiveTimer(
          chatId,
          messageId,
          taskId,
          taskName || "Study/Work",
          projectId || null,
          projectName || null,
          null,
          null
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Mark Sub-task Done/Not Done after Session ---
      if (callbackData.startsWith("todo_fin:")) {
        const [, status, todoId] = callbackData.split(":");
        const isDone = status === "y";
        if (isDone && todoId) {
          await setProjectTodoDone(todoId, true);
        }

        const session = await getWizardSession(chatId);
        const logId = session?.task_data.sessionLogId;
        const taskName = session?.task_data.taskName;
        const task = taskName ? await findTaskByName(taskName) : null;
        const todoTitle = session?.task_data.todoTitle;

        const showReview = !!logId && !isSystemTask(task);
        const replyKb: InlineKeyboard = showReview && logId
          ? buildReviewKeyboard(logId)
          : BACK_ONLY_KEYBOARD;

        const statusIcon = isDone ? "✅" : "⏳";
        const statusText = isDone
          ? `${statusIcon} <b>"${todoTitle || "Task"}" marked as completed!</b> 🎉`
          : `${statusIcon} <b>"${todoTitle || "Task"}" kept in progress for next session.</b>`;

        const text =
          `${statusText}\n\n` +
          `Saved to your log!` +
          (showReview ? FOCUS_QUESTION : "");

        await respondUi(chatId, messageId, text, replyKb);
        return NextResponse.json({ ok: true });
      }

      // --- Timer: Pause (paused time is tracked in the DB, started_at untouched) ---
      if (callbackData === "timer_pause" || callbackData.startsWith("timer_pause:")) {
        const active = await getActiveTimer(chatId);
        if (!active) {
          await respondUi(chatId, messageId, "⏱️ No active timer is running.", []);
          return NextResponse.json({ ok: true });
        }

        const pause = await getPauseState(chatId);
        // Double-tap: keep the first pause moment
        const pausedAt = pause.pausedAt ?? Date.now();
        await setPauseState(chatId, { pausedAt, pausedSeconds: pause.pausedSeconds });

        // Pausing removes the pending "still running" nudge
        const nudge = await getNudgeState(chatId);
        if (nudge.messageId) {
          await deleteTelegramMessage(chatId, nudge.messageId);
        }
        await clearNudgeState(chatId);

        const progressStr = await getTimerProjectProgress(active.project_id);
        const pomodoroInfo = extractPomodoroInfo(active);
        const view = buildTimerView(active.task_name, active.started_at, pausedAt, pause.pausedSeconds, active.project_name, progressStr, active.todo_title, pomodoroInfo);
        await respondUi(chatId, messageId, view.text, view.keyboard);

        if (messageId) {
          await trackTimerMessage(chatId, messageId);
        }
        return NextResponse.json({ ok: true });
      }

      // --- Timer: Resume (paused time accumulates; started_at is never changed) ---
      if (callbackData.startsWith("timer_resume:")) {
        const active = await getActiveTimer(chatId);
        if (!active) {
          await respondUi(chatId, messageId, "⏱️ No active timer is running.", []);
          return NextResponse.json({ ok: true });
        }

        const pause = await getPauseState(chatId);
        const fallbackPausedAt = parseInt(callbackData.split(":")[1], 10) || 0;
        const pausedAt = pause.pausedAt ?? fallbackPausedAt;

        let pausedSeconds = pause.pausedSeconds;
        let pauseDurationMs = 0;
        if (pausedAt > 0) {
          pauseDurationMs = Math.max(0, Date.now() - pausedAt);
          pausedSeconds += Math.round(pauseDurationMs / 1000);
        }
        await setPauseState(chatId, { pausedAt: null, pausedSeconds });

        // If in Pomodoro work phase, shift phase_started_at forward by pause duration
        if (active.is_pomodoro && active.pomodoro_phase === "work" && pauseDurationMs > 0 && active.phase_started_at) {
          const newPhaseStartMs = new Date(active.phase_started_at).getTime() + pauseDurationMs;
          const newPhaseStartedAtIso = new Date(newPhaseStartMs).toISOString();
          await updateActiveTimer(chatId, { phase_started_at: newPhaseStartedAtIso });
          active.phase_started_at = newPhaseStartedAtIso;
        }

        // Nudge interval restarts from the resume moment
        const nudge = await getNudgeState(chatId);
        if (nudge.messageId) {
          await deleteTelegramMessage(chatId, nudge.messageId);
        }
        await setNudgeState(chatId, { messageId: null, nextNudgeAt: Date.now() + NUDGE_INTERVAL_MS });

        const progressStr = await getTimerProjectProgress(active.project_id);
        const pomodoroInfo = extractPomodoroInfo(active);
        const view = buildTimerView(active.task_name, active.started_at, 0, pausedSeconds, active.project_name, progressStr, active.todo_title, pomodoroInfo);
        await respondUi(chatId, messageId, view.text, view.keyboard);

        if (messageId) {
          await trackTimerMessage(chatId, messageId);
        }
        return NextResponse.json({ ok: true });
      }

      // --- Timer: Refresh Elapsed Time ---
      if (callbackData.startsWith("timer_refresh:")) {
        const active = await getActiveTimer(chatId);
        if (!active) {
          await respondUi(chatId, messageId, "⏱️ No active timer is running.", []);
          return NextResponse.json({ ok: true });
        }

        const pause = await getPauseState(chatId);
        const fallbackPausedAt = parseInt(callbackData.split(":")[1], 10) || 0;
        const progressStr = await getTimerProjectProgress(active.project_id);
        const pomodoroInfo = extractPomodoroInfo(active);
        const view = buildTimerView(
          active.task_name,
          active.started_at,
          pause.pausedAt ?? fallbackPausedAt,
          pause.pausedSeconds,
          active.project_name,
          progressStr,
          active.todo_title,
          pomodoroInfo
        );
        await respondUi(chatId, messageId, view.text, view.keyboard);

        // Refresh also clears the pending nudge (next one stays on schedule)
        const nudge = await getNudgeState(chatId);
        if (nudge.messageId) {
          await deleteTelegramMessage(chatId, nudge.messageId);
          await setNudgeState(chatId, { messageId: null, nextNudgeAt: nudge.nextNudgeAt });
        }

        if (messageId) {
          await trackTimerMessage(chatId, messageId);
        }
        return NextResponse.json({ ok: true });
      }

      // --- Pomodoro: Start Break (User manually clicks to begin the rest countdown) ---
      if (callbackData === "pomodoro_start_break") {
        const active = await getActiveTimer(chatId);
        if (!active) {
          await respondUi(chatId, messageId, "⏱️ No active timer is running.", []);
          return NextResponse.json({ ok: true });
        }

        const pause = await getPauseState(chatId);
        const now = Date.now();

        // Any time that passed between work finishing and user clicking Start Break
        // is added to pausedSeconds so it is never counted as study time
        let newPausedSeconds = pause.pausedSeconds;
        if (pause.pausedAt && pause.pausedAt > 0) {
          const waitSec = Math.max(0, Math.floor((now - pause.pausedAt) / 1000));
          newPausedSeconds += waitSec;
        }

        const nowIso = new Date(now).toISOString();
        // Keep pausedAt: now so study time continues to be paused during the break
        await setPauseState(chatId, { pausedAt: now, pausedSeconds: newPausedSeconds });
        await updateActiveTimer(chatId, {
          pomodoro_phase: "break",
          phase_started_at: nowIso,
        });

        const progressStr = await getTimerProjectProgress(active.project_id);
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
          pomodoroInfo
        );
        await respondUi(chatId, messageId, view.text, view.keyboard);
        if (messageId) {
          await trackTimerMessage(chatId, messageId);
        }
        return NextResponse.json({ ok: true });
      }

      // --- Pomodoro: Skip Break & Start Next Round ---
      if (callbackData === "pomodoro_skip_break") {
        const active = await getActiveTimer(chatId);
        if (!active) {
          await respondUi(chatId, messageId, "⏱️ No active timer is running.", []);
          return NextResponse.json({ ok: true });
        }

        const pause = await getPauseState(chatId);
        const now = Date.now();

        let newPausedSeconds = pause.pausedSeconds;
        if (pause.pausedAt && pause.pausedAt > 0) {
          const waitSec = Math.max(0, Math.floor((now - pause.pausedAt) / 1000));
          newPausedSeconds += waitSec;
        }

        const nextRound = (active.pomodoro_round || 1) + 1;
        const nowIso = new Date(now).toISOString();

        await setPauseState(chatId, { pausedAt: null, pausedSeconds: newPausedSeconds });
        await updateActiveTimer(chatId, {
          pomodoro_phase: "work",
          pomodoro_round: nextRound,
          phase_started_at: nowIso,
        });

        const progressStr = await getTimerProjectProgress(active.project_id);
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
          pomodoroInfo
        );
        await respondUi(chatId, messageId, view.text, view.keyboard);
        if (messageId) {
          await trackTimerMessage(chatId, messageId);
        }
        return NextResponse.json({ ok: true });
      }

      // --- Pomodoro: Start Next Round (from break alarm) ---
      if (callbackData === "pomodoro_next_round") {
        const active = await getActiveTimer(chatId);
        if (!active) {
          await respondUi(chatId, messageId, "⏱️ No active timer is running.", []);
          return NextResponse.json({ ok: true });
        }

        const pause = await getPauseState(chatId);
        const now = Date.now();

        let newPausedSeconds = pause.pausedSeconds;
        if (pause.pausedAt && pause.pausedAt > 0) {
          const waitSec = Math.max(0, Math.floor((now - pause.pausedAt) / 1000));
          newPausedSeconds += waitSec;
        }

        const nowIso = new Date(now).toISOString();
        await setPauseState(chatId, { pausedAt: null, pausedSeconds: newPausedSeconds });
        await updateActiveTimer(chatId, {
          pomodoro_phase: "work",
          phase_started_at: nowIso,
        });

        const progressStr = await getTimerProjectProgress(active.project_id);
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
          pomodoroInfo
        );
        await respondUi(chatId, messageId, view.text, view.keyboard);
        if (messageId) {
          await trackTimerMessage(chatId, messageId);
        }
        return NextResponse.json({ ok: true });
      }

      // --- Timer: Stop & Log (paused time excluded; only write of the session) ---
      if (
        callbackData.startsWith("timer_stop:") ||
        callbackData === "stop_active_timer" ||
        callbackData.startsWith("stop_then_open:")
      ) {
        const pause = await getPauseState(chatId);
        const fallbackPausedAt = callbackData.startsWith("timer_stop:")
          ? parseInt(callbackData.split(":")[1], 10) || 0
          : 0;
        const endMs = pause.pausedAt ?? fallbackPausedAt ?? 0;

        const result = await stopActiveTimer(chatId, endMs > 0 ? endMs : undefined, pause.pausedSeconds);
        await clearPauseState(chatId);

        // Stop removes the pending "still running" nudge
        const nudge = await getNudgeState(chatId);
        if (nudge.messageId) {
          await deleteTelegramMessage(chatId, nudge.messageId);
        }
        await clearNudgeState(chatId);

        if (!result) {
          await respondUi(chatId, messageId, "⏱️ No active timer was running.", []);
          return NextResponse.json({ ok: true });
        }

        const task = await findTaskByName(result.taskName);
        const totalToday = await getTodayTaskTotal(result.taskName);
        const target = task?.target_value || 60;
        const percent = Math.round((totalToday / target) * 100);

        // Sessions under 5 minutes skip the review unless it's a project session (and Sleep never asks for focus)
        const showReview = !!result.logId && (result.durationSeconds >= 300 || !!result.projectId) && !isSystemTask(task);
        let stopKb: InlineKeyboard = showReview
          ? buildReviewKeyboard(result.logId as string)
          : BACK_ONLY_KEYBOARD;

        // When the stop was tapped from an "open task" warning, offer the task again
        if (callbackData.startsWith("stop_then_open:")) {
          const openTaskId = callbackData.split(":")[1];
          const openTask = await getTaskById(openTaskId);
          if (openTask) {
            stopKb = [...stopKb, [{ text: `📂 Open ${openTask.name}`, callback_data: `open_task:${openTask.id}` }]];
          }
        }

        // If a specific sub-task was being worked on, ask if it was completed
        if (result.todoId && result.todoTitle) {
          await saveWizardSession(chatId, "awaiting_session_note", {
            sessionLogId: result.logId || undefined,
            promptMessageId: messageId,
            projectId: result.projectId || undefined,
            projectName: result.projectName || undefined,
            todoId: result.todoId,
            todoTitle: result.todoTitle,
            taskName: result.taskName,
          });

          const todoKb: InlineKeyboard = [
            [
              { text: "✅ Yes, Completed", callback_data: `todo_fin:y:${result.todoId}` },
              { text: "⏳ No, In Progress", callback_data: `todo_fin:n:${result.todoId}` },
            ],
          ];

          const projectLine = result.projectName ? `📦 Project: <b>${result.projectName}</b>\n` : "";
          const text =
            `🎉 <b>${result.taskName} Session Completed!</b>\n\n` +
            projectLine +
            `⏱️ This Session: <b>${formatDuration(result.durationSeconds)}</b>\n` +
            `📊 Today's Total: <b>${formatTimerMinutes(totalToday)} / ${formatTimerMinutes(target)}</b> (${percent}% of daily goal)\n\n` +
            `Saved to your log!` +
            formatSplitSummary(result.split) +
            `\n\n🎯 <b>Did you complete: "${result.todoTitle}"?</b>`;

          await respondUi(chatId, messageId, text, todoKb);
          return NextResponse.json({ ok: true });
        }

        const projectLine = result.projectName ? `📦 Project: <b>${result.projectName}</b>\n` : "";
        const text =
          `🎉 <b>${result.taskName} Session Completed!</b>\n\n` +
          projectLine +
          `⏱️ This Session: <b>${formatDuration(result.durationSeconds)}</b>\n` +
          `📊 Today's Total: <b>${formatTimerMinutes(totalToday)} / ${formatTimerMinutes(target)}</b> (${percent}% of daily goal)\n\n` +
          `Saved to your log!` +
          formatSplitSummary(result.split) +
          (showReview ? FOCUS_QUESTION : "");

        await respondUi(chatId, messageId, text, stopKb);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Counter Add (Generic) ---
      if (callbackData.startsWith("counter_add:")) {
        const [, taskId, amountStr] = callbackData.split(":");
        const amount = parseInt(amountStr, 10);
        const task = await getTaskById(taskId);
        const taskName = task ? task.name : "Habit";

        const newLog = await logActivity({
          task_id: taskId,
          task_name: taskName,
          value: amount,
        });

        const total = await getTodayTaskTotal(taskName);
        const target = task?.target_value || 5000;
        const percent = Math.min(100, Math.round((total / target) * 100));

        const replyKb: InlineKeyboard = newLog?.id
          ? buildReviewKeyboard(newLog.id)
          : BACK_ONLY_KEYBOARD;

        const text =
          `💧 <b>${taskName}</b>: Logged +${amount} ${task?.unit || ""}!\n` +
          `📊 Today: <b>${total.toLocaleString()} / ${formatGoalDisplay(target, task?.unit)}</b> (${percent}%)` +
          (newLog?.id ? FOCUS_QUESTION : "");

        await respondUi(chatId, messageId, text, replyKb);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Tick Task (Mark Done - Idempotent with Undo Button) ---
      if (callbackData.startsWith("tick_task:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        const taskName = task ? task.name : "Routine";

        const alreadyDone = await isTaskCompletedToday(taskId);
        if (!alreadyDone) {
          await logActivity({
            task_id: taskId,
            task_name: taskName,
            value: 1,
            notes: `Completed at ${localTimeString(new Date(), true)}`,
          });
        }
        await deduplicateTodayTickLogs(taskId);

        const undoKeyboard: InlineKeyboard = [
          [{ text: `↩️ Undo (Mark Incomplete)`, callback_data: `untick_task:${taskId}` }],
          [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
        ];

        const text = `✅ <b>${taskName}</b> marked as completed for today!`;
        await respondUi(chatId, messageId, text, undoKeyboard);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Untick Task (Undo / Mark Incomplete) ---
      if (callbackData.startsWith("untick_task:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        const taskName = task ? task.name : "Routine";

        await untickTaskToday(taskId);

        const tickKeyboard: InlineKeyboard = [
          [{ text: `✅ Mark Done for Today`, callback_data: `tick_task:${taskId}` }],
          [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
        ];

        const text = `⭕ <b>${taskName}</b> unmarked for today.`;
        await respondUi(chatId, messageId, text, tickKeyboard);
        return NextResponse.json({ ok: true });
      }
    }

    // =========================================================================
    // 2. HANDLE TEXT MESSAGES (Dedicated Commands, Wizard Steps, Diary)
    // =========================================================================
    if (body.message?.text) {
      const text = body.message.text.trim();
      const chatId = body.message.chat.id;
      const messageId = body.message.message_id;

      // While a timer is running (or paused), EVERYTHING except /start and answers to an
      // already-open wizard is ignored and removed, so the timer's
      // Pause / Stop / Refresh buttons are the only active surface.
      const activeSession = await getWizardSession(chatId);
      const isWizardAnswer = activeSession && !text.startsWith("/");
      const isAllowedDuringTimer = text === "/start";
      if (!isWizardAnswer && !isAllowedDuringTimer) {
        const runningTimer = await getActiveTimer(chatId);
        if (runningTimer) {
          if (messageId) {
            await deleteTelegramMessage(chatId, messageId);
          }
          return NextResponse.json({ ok: true });
        }
      }

      // --- Command: /cancel ---
      if (text === "/cancel") {
        await clearWizardSessionAndRetirePrompt(chatId);
        await sendTelegramMessage(chatId, "❌ <i>Action cancelled.</i>");
        return NextResponse.json({ ok: true });
      }

      // --- Command: /start ---
      if (text === "/start") {
        await clearWizardSessionAndRetirePrompt(chatId);
        await setActiveTask(chatId, null);
        await setBotCommands(BOT_COMMANDS);

        // If a timer is currently active, re-send the live timer controls so user can control it
        const runningTimer = await getActiveTimer(chatId);
        if (runningTimer) {
          const pause = await getPauseState(chatId);
          const progressStr = await getTimerProjectProgress(runningTimer.project_id);
          const pomodoroInfo = extractPomodoroInfo(runningTimer);
          const view = buildTimerView(
            runningTimer.task_name,
            runningTimer.started_at,
            pause.pausedAt ?? 0,
            pause.pausedSeconds,
            runningTimer.project_name,
            progressStr,
            runningTimer.todo_title,
            pomodoroInfo
          );

          const sentMessageId = await sendUiMessage(
            chatId,
            `⏳ <b>Active Timer: ${runningTimer.task_name}</b>\n\n${view.text}`,
            view.keyboard
          );
          if (sentMessageId) {
            await trackTimerMessage(chatId, sentMessageId);
          }
          return NextResponse.json({ ok: true });
        }

        const welcomeText =
          `👋 <b>Welcome to your Personal Habit & Life-Log Assistant!</b>\n\n` +
          `<b>Available Commands:</b>\n` +
          `• <b>/tasks</b> — 📋 View today's scheduled tasks\n` +
          `• <b>/alltasks</b> — 📋 View all tasks across all days\n` +
          `• <b>/todo</b> — 📝 One-time to-dos with date & time\n` +
          `• <b>/doubt</b> — ❓ Log or view study & coding doubts\n` +
          `• <b>/log</b> — 📖 Write daily diary & mood reflection\n` +
          `• <b>/today</b> — 📊 Daily scorecard & habits progress\n` +
          `• <b>/email [date]</b> — 📧 Email summary debrief\n` +
          `   <i>Examples: <code>/email</code>, <code>/email today</code>, <code>/email 3 days ago</code>, <code>/email 2026-11-01</code></i>\n` +
          `• <b>/settings</b> — ⚙️ Anti-slacking guard & email preferences\n` +
          `• <b>/ask &lt;question&gt;</b> — 🤖 Ask AI anything about your past data\n` +
          `• <b>/addtask</b> — ➕ Create a new habit (guided wizard)\n` +
          `• <b>/edit</b> — ✏️ Edit or delete tasks\n\n` +
          `Type any command above or tap the blue <b>≡ Menu</b> button to begin!`;

        await sendTelegramMessage(chatId, welcomeText);
        return NextResponse.json({ ok: true });
      }

      // --- Command: /log or /diary (Dedicated Diary Command) ---
      if (text.startsWith("/log") || text.startsWith("/diary")) {
        await setActiveTask(chatId, null);
        const noteContent = text.replace(/^\/(log|diary)\s*/i, "").trim();

        if (noteContent.length >= 3) {
          const diaryTasks = await getActiveTasks();
          const ai = await parseUserMessageWithAI(noteContent, diaryTasks.map((t) => t.name));

          if (!ai.isMeaningful) {
            await sendTelegramMessage(
              chatId,
              `⚠️ <b>Meaningless or unclear log detected.</b>\n\n` +
                `I couldn't understand that reflection. Please share what you worked on, learned, or how your day went:\n\n` +
                `<i>(e.g., "Studied physics for 2 hours, finished chapter 3, feeling productive!")</i>`
            );
            return NextResponse.json({ ok: true });
          }

          const mood = ai.diary?.mood || "okay";
          const summary = ai.diary?.summary || noteContent.slice(0, 120);

          const newLog = await logActivity({
            task_name: "Diary",
            notes: noteContent,
            value: 1,
            summary,
            projects: ai.diary?.projects || [],
            people: ai.diary?.people || [],
            decisions: ai.diary?.decisions || [],
            mood,
          });

          const attached = await attachDiarySubjects(ai, diaryTasks);

          const moodDisplay = formatMoodDisplay(mood);
          let reply = `📖 <b>Diary Saved for Today!</b>\n\n`;
          if (moodDisplay) {
            reply += `<b>Mood:</b> ${moodDisplay}\n`;
          }
          reply += `📝 <b>Summary:</b> ${summary}`;

          if (ai.diary?.projects && ai.diary.projects.length > 0) {
            reply += `\n🎯 <b>Projects:</b> ${ai.diary.projects.join(", ")}`;
          }
          if (ai.diary?.people && ai.diary.people.length > 0) {
            reply += `\n👥 <b>People:</b> ${ai.diary.people.join(", ")}`;
          }
          if (ai.diary?.decisions && ai.diary.decisions.length > 0) {
            reply += `\n💡 <b>Decisions:</b> ${ai.diary.decisions.join(", ")}`;
          }

          if (attached.length > 0) {
            reply += `\n\n📝 <b>Attached from diary:</b>`;
            for (const a of attached) {
              reply += `\n• <b>${a.task}</b> — ${a.detail}`;
            }
          }

          const logId = newLog?.id || "";
          const moodKb: InlineKeyboard = [
            [
              { text: mood === "happy" ? "✅ 😊 Happy" : "😊 Happy", callback_data: `set_mood:${logId}:happy` },
              { text: mood === "productive" ? "✅ ⚡ Productive" : "⚡ Productive", callback_data: `set_mood:${logId}:productive` },
              { text: mood === "okay" ? "✅ 😐 Okay" : "😐 Okay", callback_data: `set_mood:${logId}:okay` },
            ],
            [
              { text: mood === "bad" ? "✅ 😔 Bad" : "😔 Bad", callback_data: `set_mood:${logId}:bad` },
              { text: mood === "tired" ? "✅ 😴 Tired" : "😴 Tired", callback_data: `set_mood:${logId}:tired` },
              { text: mood === "grateful" ? "✅ 🙏 Grateful" : "🙏 Grateful", callback_data: `set_mood:${logId}:grateful` },
            ],
          ];

          if (!ai.aiUsed) {
            reply += `\n\n<i>⚠️ AI was unavailable (quota/offline) — saved without an AI summary.</i>`;
          }
          await sendUiMessage(chatId, reply, moodKb);
          return NextResponse.json({ ok: true });
        } else {
          await sendWizardPrompt(
            chatId,
            "awaiting_diary_text",
            {},
            `📖 <b>Daily Diary & Summary</b>\n\n` +
              `Please send your reflection or notes for today:\n` +
              `<i>(e.g., "Studied physics for 2 hours and finished chapter 3 problems. Met Vishnu to discuss textures for 3D game.")</i>`,
            [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]]
          );
          return NextResponse.json({ ok: true });
        }
      }

      // --- Command: /addtask (START WIZARD) ---
      if (text === "/addtask") {
        await clearWizardSessionAndRetirePrompt(chatId);
        await setActiveTask(chatId, null);
        const typeKeyboard: InlineKeyboard = [
          [
            { text: "⏱️ Timer", callback_data: "wizard_type:timer" },
            { text: "💧 Counter", callback_data: "wizard_type:counter" },
            { text: "📌 Daily Tick", callback_data: "wizard_type:tick" },
          ],
          [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
        ];

        const promptText =
          `➕ <b>Create a New Task</b>\n\n` +
          `What kind of task is this?\n` +
          `• ⏱️ <b>Timer:</b> Study, coding, workout (time goal in hours & minutes)\n` +
          `• 💧 <b>Counter:</b> Amount & unit goal (e.g. 10 km, 5000 ml, 50 pages)\n` +
          `• 📌 <b>Daily Tick:</b> Wake up, meditation (yes/no daily completion)`;

        await sendUiMessage(chatId, promptText, typeKeyboard);
        return NextResponse.json({ ok: true });
      }

      // --- Command: /tasks or /task (Today's Scheduled Tasks) ---
      if (text === "/tasks" || text === "/task") {
        await setActiveTask(chatId, null);
        const tasks = await getActiveTasks();
        if (tasks.length === 0) {
          await sendTelegramMessage(
            chatId,
            "📋 <b>No tasks created yet!</b>\nType /addtask to create your first routine."
          );
          return NextResponse.json({ ok: true });
        }

        const taskButtons = await buildTaskListButtons(tasks, true);
        taskButtons.push([{ text: "📋 See All Tasks", callback_data: "menu_alltasks" }]);

        if (taskButtons.length === 1) {
          await sendUiMessage(
            chatId,
            "💤 <b>No tasks scheduled for today.</b>\n<i>Your other tasks are set for different days.</i>",
            taskButtons
          );
        } else {
          const { long: dayLong } = localWeekday();
          await sendUiMessage(
            chatId,
            `📋 <b>Today's Tasks</b> <i>(${dayLong})</i>:\nTap a task to log or start:`,
            taskButtons
          );
        }
        return NextResponse.json({ ok: true });
      }

      // --- Command: /alltasks (All Active Tasks, Any Day) ---
      if (text === "/alltasks") {
        await setActiveTask(chatId, null);
        const tasks = await getActiveTasks();
        if (tasks.length === 0) {
          await sendTelegramMessage(
            chatId,
            "📋 <b>No tasks created yet!</b>\nType /addtask to create your first routine."
          );
          return NextResponse.json({ ok: true });
        }

        const taskButtons = await buildTaskListButtons(tasks, false);
        taskButtons.push([{ text: "📅 Today's Tasks Only", callback_data: "menu_tasks" }]);
        await sendUiMessage(
          chatId,
          "📋 <b>All Tasks</b> <i>(all days)</i>:\nTap a task to log or start:",
          taskButtons
        );
        return NextResponse.json({ ok: true });
      }

      // --- Command: /edit (Task list -> Manage -> Edit / Delete) ---
      if (text === "/edit") {
        await setActiveTask(chatId, null);
        const tasks = await getActiveTasks();
        if (tasks.length === 0) {
          await sendUiMessage(chatId, "📋 <b>No tasks to edit yet!</b>\nType /addtask to create one.");
          return NextResponse.json({ ok: true });
        }

        const taskButtons: InlineKeyboard = tasks.map((t) => [
          {
            text: `${taskEmoji(t)} ${t.name}`,
            callback_data: `manage_task:${t.id}`,
          },
        ]);

        await sendUiMessage(chatId, "✏️ <b>Edit Tasks</b>\nTap a task to edit or delete:", taskButtons);
        return NextResponse.json({ ok: true });
      }

      // --- Command: /todo (one-time reminders with date & time) ---
      if (text === "/todo" || text === "/todos") {
        await setActiveTask(chatId, null);
        const todos = await getTodos();
        await sendUiMessage(chatId, buildTodoListText(todos), buildTodoListKeyboard(todos));
        return NextResponse.json({ ok: true });
      }

      // --- Command: /doubt (Interactive Doubt Tracker) ---
      if (
        text === "/doubt" ||
        text === "/doubts" ||
        text.startsWith("/doubt ") ||
        text.startsWith("/doubts ")
      ) {
        await clearWizardSessionAndRetirePrompt(chatId);
        await setActiveTask(chatId, null);
        await sendUiMessage(chatId, buildDoubtMenuText(), buildDoubtMenuKeyboard());
        return NextResponse.json({ ok: true });
      }

      // --- Command: /ask (AI analytics over your data via tool calling) ---
      if (text === "/ask" || text.startsWith("/ask ")) {
        const question = text.replace(/^\/ask\s*/i, "").trim();
        if (question.length < 3) {
          await sendUiMessage(
            chatId,
            `🤖 <b>Ask about your data</b>\n\n` +
              `Examples:\n` +
              `• <code>/ask how much did I study this week?</code>\n` +
              `• <code>/ask physics percentage last 30 days</code>\n` +
              `• <code>/ask my mood trend this month</code>\n` +
              `• <code>/ask pending todos</code>`
          );
          return NextResponse.json({ ok: true });
        }

        await sendUiMessage(chatId, "🤖 <i>Looking at your data…</i>");
        const taskNames = (await getActiveTasks()).map((t) => t.name);
        const answer = await askAboutData(question, taskNames);
        await sendUiMessage(chatId, answer);
        return NextResponse.json({ ok: true });
      }

      // --- Command: /settings (Idle guardian and preferences) ---
      if (text === "/settings" || text === "/idle") {
        await setActiveTask(chatId, null);
        const view = await buildSettingsView(chatId);
        await sendUiMessage(chatId, view.text, view.keyboard);
        return NextResponse.json({ ok: true });
      }

      // --- Command: /email or /mail [optional date] ---
      if (text.startsWith("/email") || text.startsWith("/mail")) {
        await setActiveTask(chatId, null);
        const arg = text.replace(/^\/(email_summary|email|mail)\s*/i, "").trim().toLowerCase();

        if (arg === "help" || arg === "?") {
          await sendTelegramMessage(
            chatId,
            `📧 <b>Email Debrief Commands:</b>\n\n` +
            `• <code>/email</code> — Yesterday's summary (default)\n` +
            `• <code>/email today</code> — Today's summary so far\n` +
            `• <code>/email 2026-11-02</code> — Specific date (YYYY-MM-DD)\n` +
            `• <code>/email 3 days ago</code> — By days in the past\n\n` +
            `<i>Change your recipient email anytime in /settings!</i>`
          );
          return NextResponse.json({ ok: true });
        }

        const today = localDateString();
        let targetDate = shiftDateString(today, -1); // default yesterday

        if (arg) {
          if (arg === "today") {
            targetDate = today;
          } else if (arg === "yesterday") {
            targetDate = shiftDateString(today, -1);
          } else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
            targetDate = arg;
          } else if (/^(\d+)\s*days?\s*ago$/i.test(arg)) {
            const daysAgo = parseInt(arg.match(/^(\d+)/)![1], 10);
            targetDate = shiftDateString(today, -daysAgo);
          } else if (/^\d+$/.test(arg)) {
            const daysAgo = parseInt(arg, 10);
            targetDate = shiftDateString(today, -daysAgo);
          }
        }

        await sendTelegramMessage(chatId, `⏳ Compiling summary for <b>${targetDate}</b> and sending email...`);
        const userSettings = await getUserSettings(chatId);
        const recipient = userSettings.summary_email_to || process.env.SUMMARY_EMAIL_TO;
        const result = await sendDailySummaryEmail(targetDate, recipient || undefined);
        if (result.sent) {
          await sendTelegramMessage(
            chatId,
            `📧 <b>Email Delivered!</b>\n\n` +
            `Summary for <b>${result.summary?.dateFormatted || targetDate}</b> was sent to <code>${recipient}</code> via <b>${result.provider}</b>.\n` +
            `• Focus time: <b>${result.summary ? formatTimerMinutes(result.summary.totalFocusMin) : "N/A"}</b>\n` +
            `• Completed items: <b>${result.summary ? result.summary.completedTodos.length : 0}</b>\n` +
            `• Incomplete items: <b>${result.summary ? result.summary.incompleteTodos.length : 0}</b>\n\n` +
            `💡 <i>Tip: Request any past day using: <code>/email 2026-11-01</code> or <code>/email 3 days ago</code></i>`
          );
        } else {
          await sendTelegramMessage(
            chatId,
            `⚠️ <b>Email Could Not Be Sent:</b>\n\n` +
            `Reason: ${result.error || result.reason}\n\n` +
            `You can update your email anytime right here in <b>/settings</b> → [✏️ Change Email]!`
          );
        }
        return NextResponse.json({ ok: true });
      }

      // --- Command: /status (graceful fallback: timer if running, else scorecard) ---
      if (text === "/status") {
        await setActiveTask(chatId, null);
        const active = await getActiveTimer(chatId);
        if (active) {
          const pause = await getPauseState(chatId);
          const progressStr = await getTimerProjectProgress(active.project_id);
          const pomodoroInfo = extractPomodoroInfo(active);
          const view = buildTimerView(
            active.task_name,
            active.started_at,
            pause.pausedAt ?? 0,
            pause.pausedSeconds,
            active.project_name,
            progressStr,
            active.todo_title,
            pomodoroInfo
          );
          const sentId = await sendUiMessage(chatId, view.text, view.keyboard);
          if (sentId) {
            await trackTimerMessage(chatId, sentId);
          }
        } else {
          const scorecard = await buildTodayScorecard(chatId);
          await sendTelegramMessage(chatId, scorecard);
        }
        return NextResponse.json({ ok: true });
      }

      // --- Command: /today ---
      if (text === "/today") {
        await setActiveTask(chatId, null);
        const scorecard = await buildTodayScorecard(chatId);
        await sendTelegramMessage(chatId, scorecard);
        return NextResponse.json({ ok: true });
      }

      // =======================================================================
      // 3. CONVERSATIONAL WIZARD STATE HANDLER
      // =======================================================================
      if (activeSession) {
        // --- State: User Answering Session Note Prompt ---
        if (activeSession.step === "awaiting_session_note") {
          const logId = activeSession.task_data.sessionLogId;
          const promptMessageId = activeSession.task_data.promptMessageId;
          const projectId = activeSession.task_data.projectId;
          const projectName = activeSession.task_data.projectName;
          await clearWizardSession(chatId);

          if (promptMessageId) {
            try {
              await removeInlineKeyboard(chatId, promptMessageId);
            } catch {}
          }

          if (logId) {
            await updateLogSessionNote(logId, text);
          }

          const sanitized = text
            .trim()
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

          if (projectId) {
            const kb: InlineKeyboard = [
              [
                { text: "✅ Yes, Completed", callback_data: `project_complete:${projectId}` },
                { text: "⏳ No, In Progress", callback_data: `project_keep_open:${projectId}` },
              ],
              [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
            ];
            await sendUiMessage(
              chatId,
              `✅ <b>Note saved to session!</b>\n\n` +
                `📝 <i>"${sanitized}"</i>\n\n` +
                `🏁 <b>Project: "${projectName || "Active Project"}"</b>\n` +
                `Did you complete this project?`,
              kb
            );
            return NextResponse.json({ ok: true });
          }

          await sendUiMessage(
            chatId,
            `✅ <b>Note saved to session!</b>\n\n` +
              `📝 <i>"${sanitized}"</i>`,
            [[{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }]]
          );
          return NextResponse.json({ ok: true });
        }

        // --- State: User Entering Project Name for Project-Based Task ---
        if (activeSession.step === "awaiting_project_name") {
          const projectName = text.trim();
          const taskId = activeSession.task_data.taskId!;
          const promptId = activeSession.task_data.promptMessageId;

          if (projectName.length < 2) {
            await sendWizardPrompt(
              chatId,
              "awaiting_project_name",
              activeSession.task_data,
              "⚠️ Please provide a valid project name with at least 2 characters (e.g. <b>Making PPT for Optics</b>):",
              [[{ text: "❌ Cancel", callback_data: `open_task:${taskId}` }]]
            );
            return NextResponse.json({ ok: true });
          }

          if (promptId) {
            try {
              await removeInlineKeyboard(chatId, promptId);
            } catch {}
          }

          const targetKb: InlineKeyboard = [
            [
              { text: "1 hour", callback_data: `project_target:60` },
              { text: "2 hours", callback_data: `project_target:120` },
              { text: "4 hours", callback_data: `project_target:240` },
              { text: "8 hours", callback_data: `project_target:480` },
            ],
            [{ text: "⏭️ Skip Goal (No Target)", callback_data: `project_target:skip` }],
            [{ text: "❌ Cancel", callback_data: `open_task:${taskId}` }],
          ];

          await sendWizardPrompt(
            chatId,
            "awaiting_project_target",
            {
              ...activeSession.task_data,
              projectName,
            },
            `🎯 <b>Estimated Goal for "${projectName}"?</b>\n\n` +
              `How many hours do you estimate this project will take?\n` +
              `<i>(e.g., "3 hours", "1h 30m", "4.5h")</i>\n\n` +
              `— <b>OR tap a quick goal below:</b>`,
            targetKb
          );
          return NextResponse.json({ ok: true });
        }

        // --- State: User Typed Project Target Hours ---
        if (activeSession.step === "awaiting_project_target") {
          const parsedMins = parseTimerGoal(text);
          const taskId = activeSession.task_data.taskId!;
          const promptId = activeSession.task_data.promptMessageId;

          if (!parsedMins || parsedMins <= 0) {
            await sendWizardPrompt(
              chatId,
              "awaiting_project_target",
              activeSession.task_data,
              `⚠️ Please enter valid hours & minutes like <b>2 hours</b>, <b>1h 30m</b>, or tap <b>Skip Goal</b>:`,
              [
                [{ text: "⏭️ Skip Goal (No Target)", callback_data: `project_target:skip` }],
                [{ text: "❌ Cancel", callback_data: `open_task:${taskId}` }],
              ]
            );
            return NextResponse.json({ ok: true });
          }

          if (promptId) {
            try {
              await removeInlineKeyboard(chatId, promptId);
            } catch {}
          }

          const taskData = activeSession.task_data;
          const descKb: InlineKeyboard = [
            [{ text: "▶️ Start Timer Now (Skip Note)", callback_data: "project_desc:skip" }],
            [{ text: "❌ Cancel", callback_data: `open_task:${taskId}` }],
          ];

          await sendWizardPrompt(
            chatId,
            "awaiting_project_description",
            {
              ...taskData,
              projectTargetMinutes: parsedMins,
            },
            `📝 <b>Project Description / Outline (Optional)</b>\n\n` +
              `Project: <b>${taskData.projectName}</b>\n` +
              `Goal: <b>${formatTimerMinutes(parsedMins)}</b>\n\n` +
              `Type a short note or checklist for this project (e.g. <i>"Cover formulas and 10 questions"</i>):\n\n` +
              `— <b>OR tap Start Timer to begin right away:</b>`,
            descKb
          );
          return NextResponse.json({ ok: true });
        }

        // --- State: User Typed Project Description / Outline ---
        if (activeSession.step === "awaiting_project_description") {
          const description = text.trim();
          const taskData = activeSession.task_data;
          const taskId = taskData.taskId!;
          const taskName = taskData.taskName || "Study/Work";
          const projectName = taskData.projectName!;
          const targetMinutes = taskData.projectTargetMinutes ?? null;
          const promptId = taskData.promptMessageId;

          const project = await createProject(taskId, projectName, targetMinutes, description);
          if (project && taskData.transferTodoIds && taskData.transferTodoIds.length > 0) {
            const today = localDateString();
            await transferTodosToProject(taskData.transferTodoIds, project.id, today);
          }
          await clearWizardSession(chatId);

          if (promptId) {
            try {
              await removeInlineKeyboard(chatId, promptId);
            } catch {}
          }

          await promptOrStartTimer(chatId, undefined, taskId, taskName, project?.id || null, project?.name || projectName);
          return NextResponse.json({ ok: true });
        }

        // --- State: User In Project To-Dos Resolution Prompt ---
        if (activeSession.step === "awaiting_project_todos_resolution") {
          const taskData = activeSession.task_data;
          const taskId = taskData.taskId!;
          const pastIds = taskData.pastTodoIds || [];

          const kb: InlineKeyboard = [
            [{ text: `✅ Mark All Done (${pastIds.length})`, callback_data: `proj_todos_act:done` }],
            [{ text: `📥 Move to New Project (${pastIds.length})`, callback_data: `proj_todos_act:move` }],
            [{ text: `📦 Archive as Incomplete (${pastIds.length})`, callback_data: `proj_todos_act:archive` }],
            [{ text: "❌ Cancel", callback_data: `open_task:${taskId}` }],
          ];

          await sendTelegramMessage(
            chatId,
            "⚠️ Please tap an option below regarding the unfinished tasks from your previous project:",
            kb
          );
          return NextResponse.json({ ok: true });
        }

        // --- State: User In Carry-Over Prompt ---
        if (activeSession.step === "awaiting_daily_todo_carryover") {
          const taskData = activeSession.task_data;
          const taskId = taskData.taskId!;
          const pastIds = taskData.pastTodoIds || [];

          const kb: InlineKeyboard = [
            [{ text: `📥 Carry Over to Today (${pastIds.length})`, callback_data: "carryover_apply" }],
            [{ text: "✨ Start Fresh / New Tasks", callback_data: "carryover_fresh" }],
            [{ text: "🗑️ Dismiss Past Tasks", callback_data: "carryover_dismiss" }],
            [{ text: "▶️ Start Timer (Leave Blank)", callback_data: "daily_todo_skip" }],
            [{ text: "❌ Cancel", callback_data: `open_task:${taskId}` }],
          ];

          await sendTelegramMessage(
            chatId,
            "⚠️ Please tap an option below regarding your unfinished tasks from previous sessions:",
            kb
          );
          return NextResponse.json({ ok: true });
        }

        // --- State: User Adding Daily To-Dos for Project / Task ---
        if (activeSession.step === "awaiting_daily_todo_input") {
          const taskData = activeSession.task_data;
          const taskId = taskData.taskId!;
          const projectId = taskData.projectId || null;
          const promptId = taskData.promptMessageId;

          // Split by newlines and commas, and strip numbering / bullets
          const rawText = String(text || "");
          const lines = rawText.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
          const newItems: string[] = [];

          for (const line of lines) {
            if (line.includes(",")) {
              const parts = line.split(",").map((p: string) => p.trim()).filter(Boolean);
              for (const part of parts) {
                const cleaned = part.replace(/^(\d+[\.\)]\s*|[-•*]\s*)/, "").trim();
                if (cleaned.length >= 2) {
                  newItems.push(cleaned);
                }
              }
            } else {
              const cleaned = line.replace(/^(\d+[\.\)]\s*|[-•*]\s*)/, "").trim();
              if (cleaned.length >= 2) {
                newItems.push(cleaned);
              }
            }
          }

          if (newItems.length === 0) {
            await sendTelegramMessage(chatId, "⚠️ Task name is too short. Please enter a valid task description:");
            return NextResponse.json({ ok: true });
          }

          // Add each to-do and verify insertion
          const addedTodos: ProjectTodo[] = [];
          for (const item of newItems) {
            const saved = await addProjectTodo(taskId, projectId, item);
            if (saved) {
              addedTodos.push(saved);
            }
          }

          if (addedTodos.length === 0) {
            await sendTelegramMessage(
              chatId,
              "⚠️ <b>Database Error:</b> Could not save tasks to Supabase.\n\n" +
                "Row Level Security (RLS) is blocking access on <code>project_todos</code>.\n\n" +
                "👉 Please run this in your Supabase SQL Editor:\n" +
                "<code>ALTER TABLE project_todos DISABLE ROW LEVEL SECURITY;</code>"
            );
            return NextResponse.json({ ok: true });
          }

          // Get all to-dos added today
          const today = localDateString();
          let todos = projectId
            ? await getDailyTodosForProject(projectId, today)
            : await getDailyTodosForTask(taskId, today);

          if (todos.length === 0 && addedTodos.length > 0) {
            todos = addedTodos;
          }

          const listText = todos
            .map((t, idx) => `${idx + 1}. ${t.title}`)
            .join("\n");
          const projectLine = taskData.projectName ? `📦 Project: <b>${taskData.projectName}</b>\n` : "";
          const addedBadge =
            newItems.length > 1
              ? `<i>(Added ${newItems.length} tasks)</i>\n\n`
              : `<i>(Added: ${newItems[0]})</i>\n\n`;

          const startLabel =
            todos.length === 1
              ? `▶️ Start Timer (1 task)`
              : `▶️ Done / Start Timer (${todos.length} tasks)`;

          const kb: InlineKeyboard = [
            [{ text: startLabel, callback_data: "daily_todo_done" }],
            [{ text: "❌ Cancel", callback_data: `open_task:${taskId}` }],
          ];

          if (promptId) {
            try {
              await removeInlineKeyboard(chatId, promptId);
            } catch {}
          }

          const promptHint =
            todos.length === 1
              ? `Send another task to add, or tap <b>Start Timer</b> below:`
              : `Send more tasks to add (one by one or comma-separated), or tap <b>Done / Start Timer</b> below:`;

          const sentId = await sendUiMessage(
            chatId,
            `${projectLine}📋 <b>Today's Plan:</b>\n${addedBadge}` +
              `${listText}\n\n` +
              promptHint,
            kb
          );

          await saveWizardSession(chatId, "awaiting_daily_todo_input", {
            ...taskData,
            promptMessageId: sentId || undefined,
          });
          return NextResponse.json({ ok: true });
        }

        // --- State: User Answering Diary Prompt ---
        if (activeSession.step === "awaiting_diary_text") {
          const diaryPromptId = activeSession.task_data.promptMessageId;
          const diaryTasks = await getActiveTasks();
          const ai = await parseUserMessageWithAI(text, diaryTasks.map((t) => t.name));

          if (!ai.isMeaningful) {
            await sendWizardPrompt(
              chatId,
              "awaiting_diary_text",
              activeSession.task_data,
              `⚠️ <b>That doesn't look like a meaningful log.</b>\n\n` +
                `I couldn't understand that reflection. Please share what you worked on, learned, or how your day went:\n\n` +
                `<i>(e.g., "Studied physics for 2 hours and finished chapter 3, feeling productive!")</i>`,
              [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]]
            );
            return NextResponse.json({ ok: true });
          }

          await clearWizardSession(chatId);
          const mood = ai.diary?.mood || "okay";
          const summary = ai.diary?.summary || text.slice(0, 120);

          const newLog = await logActivity({
            task_name: "Diary",
            notes: text,
            value: 1,
            summary,
            projects: ai.diary?.projects || [],
            people: ai.diary?.people || [],
            decisions: ai.diary?.decisions || [],
            mood,
          });

          const attached = await attachDiarySubjects(ai, diaryTasks);

          const moodDisplay = formatMoodDisplay(mood);
          let reply = `📖 <b>Diary Saved for Today!</b>\n\n`;
          if (moodDisplay) {
            reply += `<b>Mood:</b> ${moodDisplay}\n`;
          }
          reply += `📝 <b>Summary:</b> ${summary}`;

          if (ai.diary?.projects && ai.diary.projects.length > 0) {
            reply += `\n🎯 <b>Projects:</b> ${ai.diary.projects.join(", ")}`;
          }
          if (ai.diary?.people && ai.diary.people.length > 0) {
            reply += `\n👥 <b>People:</b> ${ai.diary.people.join(", ")}`;
          }
          if (ai.diary?.decisions && ai.diary.decisions.length > 0) {
            reply += `\n💡 <b>Decisions:</b> ${ai.diary.decisions.join(", ")}`;
          }

          if (attached.length > 0) {
            reply += `\n\n📝 <b>Attached from diary:</b>`;
            for (const a of attached) {
              reply += `\n• <b>${a.task}</b> — ${a.detail}`;
            }
          }

          const logId = newLog?.id || "";
          const moodKb: InlineKeyboard = [
            [
              { text: mood === "happy" ? "✅ 😊 Happy" : "😊 Happy", callback_data: `set_mood:${logId}:happy` },
              { text: mood === "productive" ? "✅ ⚡ Productive" : "⚡ Productive", callback_data: `set_mood:${logId}:productive` },
              { text: mood === "okay" ? "✅ 😐 Okay" : "😐 Okay", callback_data: `set_mood:${logId}:okay` },
            ],
            [
              { text: mood === "bad" ? "✅ 😔 Bad" : "😔 Bad", callback_data: `set_mood:${logId}:bad` },
              { text: mood === "tired" ? "✅ 😴 Tired" : "😴 Tired", callback_data: `set_mood:${logId}:tired` },
              { text: mood === "grateful" ? "✅ 🙏 Grateful" : "🙏 Grateful", callback_data: `set_mood:${logId}:grateful` },
            ],
          ];

          if (!ai.aiUsed) {
            reply += `\n\n<i>⚠️ AI was unavailable (quota/offline) — saved without an AI summary.</i>`;
          }
          await sendUiMessage(chatId, reply, moodKb);
          if (diaryPromptId) {
            await removeInlineKeyboard(chatId, diaryPromptId);
          }
          return NextResponse.json({ ok: true });
        }

        // --- State: User Typing Custom Minutes for Timer Task ---
        if (activeSession.step === "awaiting_timer_custom") {
          const num = parseInt(text.replace(/[^0-9]/g, ""), 10);
          if (isNaN(num) || num <= 0) {
            await sendWizardPrompt(
              chatId,
              "awaiting_timer_custom",
              activeSession.task_data,
              "⚠️ Please enter a valid number of minutes (e.g. <b>45</b> or <b>90</b>):",
              [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]]
            );
            return NextResponse.json({ ok: true });
          }

          const taskId = activeSession.task_data.taskId || "";
          const taskName = activeSession.task_data.name || "Study/Work";
          const target = activeSession.task_data.target_value || 60;

          // Manual entries can never exceed the day's remaining unaccounted time.
          const activeTimer = await getActiveTimer(chatId);
          const pauseState = await getPauseState(chatId);
          const running = activeTimer
            ? {
                taskName: activeTimer.task_name,
                startedAtMs: new Date(activeTimer.started_at).getTime(),
                pausedAtMs: pauseState.pausedAt,
                pausedSeconds: pauseState.pausedSeconds,
              }
            : null;
          const [vacantDay] = computeWastedDays({
            dates: [localDateString()],
            logs: await getTodayLogs(),
            tasks: await getActiveTasks(),
            running,
          });
          const vacant = Math.max(0, vacantDay?.wastedMin ?? 0);

          if (num > vacant) {
            await sendWizardPrompt(
              chatId,
              "awaiting_timer_custom",
              activeSession.task_data,
              `⚠️ Only <b>${formatTimerMinutes(vacant)}</b> of unaccounted time left today ` +
                `(you tried <b>${formatTimerMinutes(num)}</b>).\n\n` +
                `Enter a smaller number of minutes:`,
              [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]]
            );
            return NextResponse.json({ ok: true });
          }

          const customLog = await logActivity({
            task_id: taskId || null,
            task_name: taskName,
            value: num,
            notes: `Manual log +${num}m`,
          });

          const customPromptId = activeSession.task_data.promptMessageId;
          await clearWizardSession(chatId);

          const newTotal = await getTodayTaskTotal(taskName);
          const percent = Math.round((newTotal / target) * 100);

          const customTask = taskId ? await getTaskById(taskId) : null;
          const showCustomFocus = !!customLog?.id && !isSystemTask(customTask);

          const customKb: InlineKeyboard = showCustomFocus
            ? buildReviewKeyboard(customLog!.id as string)
            : BACK_ONLY_KEYBOARD;
          await sendUiMessage(
            chatId,
            `⏱️ <b>+${formatTimerMinutes(num)} logged for ${taskName}!</b>\n\n` +
              `📊 Today's Total: <b>${newTotal} / ${target} mins</b> (${percent}% of daily goal)` +
              (showCustomFocus ? FOCUS_QUESTION : ""),
            customKb
          );
          if (customPromptId) {
            await removeInlineKeyboard(chatId, customPromptId);
          }
          return NextResponse.json({ ok: true });
        }

        // --- State: Editing an Existing Task ---
        if (
          activeSession.step === "awaiting_edit_name" ||
          activeSession.step === "awaiting_edit_goal" ||
          activeSession.step === "awaiting_edit_reminder" ||
          activeSession.step === "awaiting_edit_days"
        ) {
          const taskId = activeSession.task_data.taskId || "";
          const task = await getTaskById(taskId);
          if (!task) {
            await clearWizardSession(chatId);
            await sendTelegramMessage(chatId, "⚠️ Task not found or deleted. Edit cancelled.");
            return NextResponse.json({ ok: true });
          }

          if (activeSession.step === "awaiting_edit_name" && isSystemTask(task)) {
            await clearWizardSession(chatId);
            await sendTelegramMessage(
              chatId,
              `🔒 <b>${task.name}</b> is a system task — its name cannot be changed.`
            );
            return NextResponse.json({ ok: true });
          }

          const failEdit = async (message: string) => {
            await sendWizardPrompt(
              chatId,
              activeSession.step,
              activeSession.task_data,
              message,
              [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]]
            );
          };

          if (activeSession.step === "awaiting_edit_name") {
            const newName = text.trim();
            if (newName.length < 2 || isQuickGibberishCheck(newName)) {
              await failEdit("⚠️ Please provide a clear, valid name with at least 2 characters:");
              return NextResponse.json({ ok: true });
            }
            const existing = await taskNameExists(newName);
            if (existing && existing.id !== task.id && !existing.is_archived) {
              await failEdit(
                `⚠️ A task named <b>"${existing.name}"</b> already exists.\n\nPlease choose a different name:`
              );
              return NextResponse.json({ ok: true });
            }
            await updateTask(task.id, { name: newName });
          } else if (activeSession.step === "awaiting_edit_goal") {
            let updates: Partial<Task> | null = null;
            if (task.type === "timer") {
              const mins = parseTimerGoal(text);
              if (mins && mins > 0) updates = { target_value: mins, unit: "minutes" };
            } else {
              const parsed = parseCountGoalAndUnit(text);
              if (parsed && parsed.value > 0) updates = { target_value: parsed.value, unit: parsed.unit };
            }
            if (!updates) {
              await failEdit(
                task.type === "timer"
                  ? `⚠️ Please enter hours & minutes like <b>2 hours</b>, <b>1h 30m</b>, or <b>45 mins</b>:`
                  : `⚠️ Please enter an amount and unit like <b>10 km</b>, <b>5000 ml</b>, or <b>50 pages</b>:`
              );
              return NextResponse.json({ ok: true });
            }
            await updateTask(task.id, updates);
          } else if (activeSession.step === "awaiting_edit_reminder") {
            const lower = text.trim().toLowerCase();
            if (["none", "remove", "no reminder", "skip"].includes(lower)) {
              await updateTask(task.id, { reminder_time: null });
            } else {
              const parsedTime = parseReminderTime(text);
              if (!parsedTime) {
                await failEdit(
                  `⚠️ I didn't recognize that time format.\n\n` +
                    `Please try like <b>08:00 AM</b>, <b>8am</b>, or <b>18:30</b>:`
                );
                return NextResponse.json({ ok: true });
              }
              await updateTask(task.id, { reminder_time: parsedTime });
            }
          } else {
            const chosenDays = parseScheduleDays(text);
            if (!chosenDays) {
              await failEdit(
                `⚠️ <b>Invalid Days of Week</b>\n\n` +
                  `I couldn't recognize those days.\n` +
                  `Please type valid days separated by comma, like:\n` +
                  `• <b>Mon, Wed, Fri</b>\n` +
                  `• <b>Saturday, Sunday</b>`
              );
              return NextResponse.json({ ok: true });
            }
            await updateTask(task.id, { target_days: chosenDays });
          }

          const updated = await getTaskById(task.id);
          await clearWizardSession(chatId);

          await sendUiMessage(
            chatId,
            `✅ <b>Task Updated!</b>\n\n${updated ? buildTaskSummary(updated) : ""}`
          );
          return NextResponse.json({ ok: true });
        }

        // --- State: Custom Pomodoro Focus Minutes ---
        if (activeSession.step === "awaiting_edit_pomodoro_work") {
          const rawNum = parseInt(text.trim(), 10);
          if (isNaN(rawNum) || rawNum <= 0 || rawNum > 240) {
            await sendWizardPrompt(
              chatId,
              "awaiting_edit_pomodoro_work",
              activeSession.task_data,
              "⚠️ Please enter a valid number of focus minutes between 1 and 240 (e.g. 25, 45, 60):",
              [[{ text: "❌ Cancel", callback_data: `menu_pomodoro:${activeSession.task_data.taskId}` }]]
            );
            return NextResponse.json({ ok: true });
          }

          const nextData = {
            ...activeSession.task_data,
            pomodoroWorkMins: rawNum,
            pomodoro_work_mins: rawNum,
          };
          await sendWizardPrompt(
            chatId,
            "awaiting_edit_pomodoro_break",
            nextData,
            `🎯 Focus set to <b>${rawNum} minutes</b>!\n\n` +
              `Now, how many minutes of break between rounds?\n` +
              `<i>(e.g., 5, 10, 15)</i>`,
            [[{ text: "❌ Cancel", callback_data: `menu_pomodoro:${activeSession.task_data.taskId}` }]]
          );
          return NextResponse.json({ ok: true });
        }

        // --- State: Custom Pomodoro Break Minutes ---
        if (activeSession.step === "awaiting_edit_pomodoro_break") {
          const rawNum = parseInt(text.trim(), 10);
          if (isNaN(rawNum) || rawNum <= 0 || rawNum > 60) {
            await sendWizardPrompt(
              chatId,
              "awaiting_edit_pomodoro_break",
              activeSession.task_data,
              "⚠️ Please enter a valid number of break minutes between 1 and 60 (e.g. 5, 10):",
              [[{ text: "❌ Cancel", callback_data: `menu_pomodoro:${activeSession.task_data.taskId}` }]]
            );
            return NextResponse.json({ ok: true });
          }

          const taskId = activeSession.task_data.taskId;
          const workMins = activeSession.task_data.pomodoroWorkMins || activeSession.task_data.pomodoro_work_mins || 25;
          const breakMins = rawNum;

          if (taskId) {
            await updateTask(taskId, {
              is_pomodoro: true,
              pomodoro_work_mins: workMins,
              pomodoro_break_mins: breakMins,
            });
          }

          await clearWizardSession(chatId);
          const task = taskId ? await getTaskById(taskId) : null;
          const taskName = task?.name || activeSession.task_data.taskName || "Task";

          await sendUiMessage(
            chatId,
            `🍅 <b>Pomodoro Configured for "${taskName}"!</b>\n\n` +
              `🎯 Focus: <b>${workMins} minutes</b>\n` +
              `☕ Break: <b>${breakMins} minutes</b>\n\n` +
              `Whenever you start this task, it will automatically run with these intervals.`,
            [
              [{ text: `▶️ Start ${taskName}`, callback_data: `start_task:${taskId}` }],
              [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
            ]
          );
          return NextResponse.json({ ok: true });
        }

        // --- State: Custom Idle Interval ---
        if (activeSession.step === "awaiting_settings_interval") {
          const rawNum = parseInt(text.trim(), 10);
          if (isNaN(rawNum) || rawNum <= 0 || rawNum > 120) {
            await sendWizardPrompt(
              chatId,
              "awaiting_settings_interval",
              activeSession.task_data,
              "⚠️ Please enter a valid number of minutes between 1 and 120 (e.g. 3, 5, 15, 30):",
              [[{ text: "❌ Cancel", callback_data: "menu_settings" }]]
            );
            return NextResponse.json({ ok: true });
          }

          await updateUserSettings(chatId, {
            idle_interval_mins: rawNum,
            last_idle_nudge_at: new Date().toISOString(),
          });
          await clearWizardSession(chatId);
          const view = await buildSettingsView(chatId);
          await sendUiMessage(
            chatId,
            `✅ <b>Idle Alert Interval set to ${rawNum} minutes!</b>\n\n${view.text}`,
            view.keyboard
          );
          return NextResponse.json({ ok: true });
        }

        // --- State: Custom Idle Active Hours Window ---
        if (activeSession.step === "awaiting_settings_window") {
          const parts = text.split(/to|-|–/).map((s: string) => s.trim());
          if (parts.length === 2) {
            const t1 = parseReminderTime(parts[0]);
            const t2 = parseReminderTime(parts[1]);
            if (t1 && t2) {
              const start = t1.slice(0, 5);
              const end = t2.slice(0, 5);
              await updateUserSettings(chatId, {
                idle_window_start: start,
                idle_window_end: end,
                last_idle_nudge_at: new Date().toISOString(),
              });
              await clearWizardSession(chatId);
              const view = await buildSettingsView(chatId);
              await sendUiMessage(
                chatId,
                `✅ <b>Active Hours Window set to ${start} – ${end}!</b>\n\n${view.text}`,
                view.keyboard
              );
              return NextResponse.json({ ok: true });
            }
          }

          await sendWizardPrompt(
            chatId,
            "awaiting_settings_window",
            activeSession.task_data,
            `⚠️ I couldn't understand that time window.\n\n` +
              `Please send like <b>05:00 to 22:00</b> or <b>6am to 10pm</b>:`,
            [[{ text: "❌ Cancel", callback_data: "menu_settings" }]]
          );
          return NextResponse.json({ ok: true });
        }

        // --- State: Custom Daily Summary Email ---
        if (activeSession.step === "awaiting_settings_email") {
          const emailInput = text.trim();
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

          if (!emailRegex.test(emailInput)) {
            await sendWizardPrompt(
              chatId,
              "awaiting_settings_email",
              activeSession.task_data,
              `⚠️ <b>Invalid Email Address:</b>\n\n` +
                `Please send a valid email address (e.g. <code>name@example.com</code>):\n\n` +
                `<i>Or type /cancel to go back.</i>`,
              [[{ text: "❌ Cancel", callback_data: "menu_settings" }]]
            );
            return NextResponse.json({ ok: true });
          }

          await setUserSummaryEmail(chatId, emailInput);
          await clearWizardSession(chatId);
          const view = await buildSettingsView(chatId);
          await sendUiMessage(
            chatId,
            `✅ <b>Summary Email Updated!</b>\n\n` +
              `Your daily summary debriefs will now be sent to <code>${emailInput.toLowerCase()}</code>.\n\n${view.text}`,
            view.keyboard
          );
          return NextResponse.json({ ok: true });
        }

        // --- State: New To-Do (title -> date -> time) ---
        if (activeSession.step === "awaiting_todo_title") {
          const title = text.trim();
          if (title.length < 2 || isQuickGibberishCheck(title)) {
            await sendWizardPrompt(
              chatId,
              "awaiting_todo_title",
              activeSession.task_data,
              "⚠️ Please send a clear to-do title (at least 2 characters):",
              [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]]
            );
            return NextResponse.json({ ok: true });
          }

          const taskData = { ...activeSession.task_data, todoTitle: title };
          await sendWizardPrompt(
            chatId,
            "awaiting_todo_date",
            taskData,
            todoDatePrompt(title),
            todoDateKb()
          );
          return NextResponse.json({ ok: true });
        }

        if (activeSession.step === "awaiting_todo_date") {
          const dateStr = parseTodoDate(text);
          if (!dateStr || dateStr < localDateString()) {
            await sendWizardPrompt(
              chatId,
              "awaiting_todo_date",
              activeSession.task_data,
              `⚠️ Please send a valid upcoming date:\n` +
                `<i>(e.g., "today", "tomorrow", "25 Sep", "28/09", "2026-09-30")</i>`,
              todoDateKb()
            );
            return NextResponse.json({ ok: true });
          }

          const taskData = { ...activeSession.task_data, todoDate: dateStr };
          await sendWizardPrompt(
            chatId,
            "awaiting_todo_time",
            taskData,
            todoTimePrompt(activeSession.task_data.todoTitle || "To-Do", dateStr),
            todoTimeKb()
          );
          return NextResponse.json({ ok: true });
        }

        if (activeSession.step === "awaiting_todo_time") {
          const parsedTime = parseReminderTime(text);
          if (!parsedTime) {
            await sendWizardPrompt(
              chatId,
              "awaiting_todo_time",
              activeSession.task_data,
              `⚠️ I didn't recognize that time.\n\nPlease try like <b>8am</b>, <b>2:30 pm</b>, or <b>18:30</b>:`,
              todoTimeKb()
            );
            return NextResponse.json({ ok: true });
          }

          const { todoTitle, todoDate } = activeSession.task_data;
          if (!todoTitle || !todoDate) {
            await clearWizardSession(chatId);
            await sendUiMessage(chatId, "⚠️ Session expired. Type /todo to start again.");
            return NextResponse.json({ ok: true });
          }

          const dueAt = zonedDateTimeToUtc(todoDate, parsedTime);
          if (dueAt.getTime() <= Date.now()) {
            await sendWizardPrompt(
              chatId,
              "awaiting_todo_time",
              activeSession.task_data,
              `⚠️ That time (<b>${todoDate} ${formatReminderTime(parsedTime)}</b>) has already passed.\n\nPlease pick a later time:`,
              todoTimeKb()
            );
            return NextResponse.json({ ok: true });
          }

          const todo = await createTodo(todoTitle, dueAt.toISOString());
          await clearWizardSession(chatId);

          if (!todo) {
            await sendUiMessage(chatId, "⚠️ Could not save the to-do. Please try again.");
            return NextResponse.json({ ok: true });
          }

          const view = buildTodoView(todo);
          await sendUiMessage(chatId, `✅ <b>To-Do saved!</b>\n\n${view.text}`, view.keyboard);
          return NextResponse.json({ ok: true });
        }

        // --- State: Doubt Topic Input with Typo Check ---
        if (activeSession.step === "awaiting_doubt_topic") {
          const inputTopic = text.trim();
          if (inputTopic.length < 2 || isQuickGibberishCheck(inputTopic)) {
            await sendWizardPrompt(
              chatId,
              "awaiting_doubt_topic",
              activeSession.task_data,
              `⚠️ Please provide a clear topic or chapter name (at least 2 letters):\n\n<i>(e.g., Electrostatics, Next.js, Optics)</i>`,
              [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]]
            );
            return NextResponse.json({ ok: true });
          }

          const taskId = activeSession.task_data.doubtTaskId!;
          const taskName = activeSession.task_data.doubtTaskName || "Subject";
          const existing = await getDoubtTopics(taskId);
          const existingNames = existing.map((e) => e.topic);

          const match = findMatchingTopic(existingNames, inputTopic);
          if (match && match.toLowerCase() !== inputTopic.toLowerCase()) {
            const confirmKb: InlineKeyboard = [
              [
                {
                  text: `✅ Yes, use "${match}"`,
                  callback_data: "doubt_tconfirm:yes",
                },
              ],
              [
                {
                  text: `➕ No, use new "${inputTopic}"`,
                  callback_data: "doubt_tconfirm:no",
                },
              ],
              [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
            ];

            await sendWizardPrompt(
              chatId,
              "awaiting_doubt_topic_confirm",
              { ...activeSession.task_data, doubtTopic: inputTopic, suggestedTopic: match },
              `💡 Did you mean existing topic <b>"${match}"</b>?\n\n` +
                `You typed <i>"${inputTopic}"</i>. Would you like to use the existing topic or create a new one?`,
              confirmKb
            );
            return NextResponse.json({ ok: true });
          }

          const chosenTopic = match || inputTopic;
          const taskData = { ...activeSession.task_data, doubtTopic: chosenTopic };

          await sendWizardPrompt(
            chatId,
            "awaiting_doubt_text",
            taskData,
            `❓ <b>${taskName} — ${chosenTopic}</b>\n\n` +
              `What is your <b>doubt</b>? Explain what you are stuck on:\n` +
              `<i>(Type your question or notes)</i>`,
            [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]]
          );
          return NextResponse.json({ ok: true });
        }

        // --- State: Doubt Question Input ---
        if (activeSession.step === "awaiting_doubt_text") {
          const doubtText = text.trim();
          if (doubtText.length < 3 || isQuickGibberishCheck(doubtText)) {
            await sendWizardPrompt(
              chatId,
              "awaiting_doubt_text",
              activeSession.task_data,
              `⚠️ Please describe your doubt clearly:\n\n<i>(e.g., "Why does the electric field inside a hollow conductor become zero?")</i>`,
              [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]]
            );
            return NextResponse.json({ ok: true });
          }

          const taskId = activeSession.task_data.doubtTaskId;
          const taskName = activeSession.task_data.doubtTaskName || "Subject";
          const topic = activeSession.task_data.doubtTopic || "General";
          const promptId = activeSession.task_data.promptMessageId;

          await clearWizardSession(chatId);

          await logActivity({
            task_id: taskId,
            task_name: taskName,
            value: 0,
            summary: `❓ Doubt: ${topic}`,
            notes: `❓ [Doubt] Topic: ${topic}\n${doubtText}`,
            projects: [topic],
          });

          const successText =
            `✅ <b>Doubt Logged!</b>\n\n` +
            `📚 <b>Subject:</b> ${taskName}\n` +
            `🔖 <b>Topic:</b> ${topic}\n` +
            `❓ <b>Question:</b> ${doubtText}\n\n` +
            `<i>Saved! You can review your doubts anytime via /doubts or /ask.</i>`;

          const successKb: InlineKeyboard = [
            [{ text: "👁️ View Doubts", callback_data: `doubt_topics:${taskId}` }],
            [{ text: "➕ Log Another Doubt", callback_data: `doubt_pick:${taskId}` }],
            [{ text: "📋 Main Menu", callback_data: "menu_tasks" }],
          ];

          await sendUiMessage(chatId, successText, successKb);
          if (promptId) {
            await removeInlineKeyboard(chatId, promptId);
          }
          return NextResponse.json({ ok: true });
        }

        // --- State: Step 1 Name Input -> Branch by Task Type ---
        if (activeSession.step === "awaiting_name") {
          const taskName = text.trim();
          if (taskName.length < 2 || isQuickGibberishCheck(taskName)) {
            await sendWizardPrompt(
              chatId,
              "awaiting_name",
              activeSession.task_data,
              "⚠️ Please provide a clear, valid task name with at least 2 characters (e.g. <b>Physics Study</b>, <b>Reading</b>):",
              [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]]
            );
            return NextResponse.json({ ok: true });
          }

          const existing = await taskNameExists(taskName);
          if (existing && !existing.is_archived) {
            await sendWizardPrompt(
              chatId,
              "awaiting_name",
              activeSession.task_data,
              `⚠️ A task named <b>"${existing.name}"</b> already exists.\n\nPlease choose a different name:`,
              [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]]
            );
            return NextResponse.json({ ok: true });
          }

          const type = activeSession.task_data.type || "timer";

          if (type === "timer") {
            // Timer -> Ask for Time Goal
            const timerData = {
              ...activeSession.task_data,
              name: taskName,
            };

            const timerPrompt =
              `🎯 <b>Daily Time Goal</b>\n\n` +
              `Task: <b>${taskName}</b>\n\n` +
              `✍️ <b>Type your goal in chat:</b>\n` +
              `<i>(e.g., "2 hours", "1h 30m", "45 mins", "3h 15m")</i>\n\n` +
              `<b>— OR tap a quick target:</b>`;

            const timerKb: InlineKeyboard = [
              [
                { text: "30 mins", callback_data: "wizard_timer_target:30" },
                { text: "1 hour", callback_data: "wizard_timer_target:60" },
                { text: "2 hours", callback_data: "wizard_timer_target:120" },
                { text: "4 hours", callback_data: "wizard_timer_target:240" },
              ],
              [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
            ];

            await sendWizardPrompt(chatId, "awaiting_timer_goal", timerData, timerPrompt, timerKb);
            return NextResponse.json({ ok: true });
          } else if (type === "counter") {
            // Counter -> Ask for Amount & Unit Goal
            const counterData = {
              ...activeSession.task_data,
              name: taskName,
            };

            const counterPrompt =
              `🎯 <b>Daily Goal & Unit</b>\n\n` +
              `Task: <b>${taskName}</b>\n\n` +
              `✍️ <b>Type your goal & unit in chat:</b>\n` +
              `<i>(e.g., "10 km", "5000 ml", "8000 steps", "50 pages", "2.5 liters")</i>\n\n` +
              `<b>— OR tap a quick target:</b>`;

            const counterKb: InlineKeyboard = [
              [
                { text: "2,000 ml", callback_data: "wizard_count_target:2000:ml" },
                { text: "5,000 ml", callback_data: "wizard_count_target:5000:ml" },
              ],
              [
                { text: "5 km", callback_data: "wizard_count_target:5:km" },
                { text: "10 km", callback_data: "wizard_count_target:10:km" },
                { text: "50 pages", callback_data: "wizard_count_target:50:pages" },
              ],
              [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
            ];

            await sendWizardPrompt(chatId, "awaiting_counter_goal", counterData, counterPrompt, counterKb);
            return NextResponse.json({ ok: true });
          } else {
            // Tick -> Skip goal! Go straight to reminder time
            const tickData = {
              ...activeSession.task_data,
              name: taskName,
              target_value: 1,
              unit: "status",
            };

            const tickReminderPrompt =
              `⏰ <b>Daily Reminder Time</b>\n\n` +
              `Task: <b>${taskName}</b>\n\n` +
              `What time should I remind you daily?\n` +
              `<i>(e.g., "05:00 AM", "8am", "18:30")</i>\n\n` +
              `Or tap <b>Skip Reminder</b> below:`;

            const tickReminderKb: InlineKeyboard = [
              [{ text: "⏭️ Skip Reminder", callback_data: "wizard_skip:reminder" }],
              [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
            ];

            await sendWizardPrompt(chatId, "awaiting_reminder", tickData, tickReminderPrompt, tickReminderKb);
            return NextResponse.json({ ok: true });
          }
        }

        // --- State: User Typed Timer Goal -> Prompt Reminder ---
        if (activeSession.step === "awaiting_timer_goal") {
          const parsedMins = parseTimerGoal(text);
          if (!parsedMins || parsedMins <= 0) {
            await sendWizardPrompt(
              chatId,
              "awaiting_timer_goal",
              activeSession.task_data,
              `⚠️ Please enter hours & minutes like <b>2 hours</b>, <b>1h 30m</b>, or <b>45 mins</b>:`,
              [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]]
            );
            return NextResponse.json({ ok: true });
          }

          const updatedData = {
            ...activeSession.task_data,
            target_value: parsedMins,
            unit: "minutes",
          };

          const reminderPrompt =
            `⏰ <b>Daily Reminder Time</b>\n\n` +
            `Task: <b>${updatedData.name}</b>\n` +
            `Goal: <b>${formatGoalDisplay(parsedMins, "minutes")}</b>\n\n` +
            `What time should I remind you daily?\n` +
            `<i>(e.g., "08:00 AM", "8am", "18:30", "8:30 pm")</i>\n\n` +
            `Or tap <b>Skip Reminder</b> below:`;

          const reminderKb: InlineKeyboard = [
            [{ text: "⏭️ Skip Reminder", callback_data: "wizard_skip:reminder" }],
            [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
          ];

          await sendWizardPrompt(chatId, "awaiting_reminder", updatedData, reminderPrompt, reminderKb);
          return NextResponse.json({ ok: true });
        }

        // --- State: User Typed Counter Goal (Amount + Unit) -> Prompt Reminder ---
        if (activeSession.step === "awaiting_counter_goal") {
          const parsed = parseCountGoalAndUnit(text);
          if (!parsed || parsed.value <= 0) {
            await sendWizardPrompt(
              chatId,
              "awaiting_counter_goal",
              activeSession.task_data,
              `⚠️ Please enter an amount and unit like <b>10 km</b>, <b>5000 ml</b>, or <b>50 pages</b>:`,
              [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]]
            );
            return NextResponse.json({ ok: true });
          }

          const updatedData = {
            ...activeSession.task_data,
            target_value: parsed.value,
            unit: parsed.unit,
          };

          const reminderPrompt =
            `⏰ <b>Daily Reminder Time</b>\n\n` +
            `Task: <b>${updatedData.name}</b>\n` +
            `Goal: <b>${formatGoalDisplay(parsed.value, parsed.unit)}</b>\n\n` +
            `What time should I remind you daily?\n` +
            `<i>(e.g., "08:00 AM", "8am", "18:30", "8:30 pm")</i>\n\n` +
            `Or tap <b>Skip Reminder</b> below:`;

          const reminderKb: InlineKeyboard = [
            [{ text: "⏭️ Skip Reminder", callback_data: "wizard_skip:reminder" }],
            [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
          ];

          await sendWizardPrompt(chatId, "awaiting_reminder", updatedData, reminderPrompt, reminderKb);
          return NextResponse.json({ ok: true });
        }

        // --- State: User Typed Reminder Time -> Prompt Which Days ---
        if (activeSession.step === "awaiting_reminder") {
          const parsedTime = parseReminderTime(text);
          if (!parsedTime) {
            await sendWizardPrompt(
              chatId,
              "awaiting_reminder",
              activeSession.task_data,
              `⚠️ I didn't recognize that time format.\n\n` +
                `Please try like <b>08:00 AM</b>, <b>8am</b>, or <b>18:30</b>.\n` +
                `Or tap <b>Skip Reminder</b> below:`,
              [
                [{ text: "⏭️ Skip Reminder", callback_data: "wizard_skip:reminder" }],
                [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
              ]
            );
            return NextResponse.json({ ok: true });
          }

          const updatedData = {
            ...activeSession.task_data,
            reminder_time: parsedTime,
          };

          const daysPrompt =
            `📅 <b>Which Days?</b>\n\n` +
            `Task: <b>${updatedData.name}</b>\n` +
            `Goal: <b>${formatGoalDisplay(updatedData.target_value, updatedData.unit)}</b>\n` +
            `Reminder: <b>${formatReminderTime(parsedTime)}</b>\n\n` +
            `Tap <b>[ 🌟 Daily ]</b> below, or type the days separated with commas:\n` +
            `<i>(e.g., "Mon, Wed, Fri" or "Monday, Saturday")</i>`;

          const daysKb: InlineKeyboard = [
            [{ text: "🌟 Daily (Every Day)", callback_data: "wizard_days:daily" }],
            [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
          ];

          await sendWizardPrompt(chatId, "awaiting_days", updatedData, daysPrompt, daysKb);
          return NextResponse.json({ ok: true });
        }

        // --- State: User Typed Custom Days -> Finalize & Save Task ---
        if (activeSession.step === "awaiting_days") {
          const chosenDays = parseScheduleDays(text);
          if (!chosenDays) {
            await sendWizardPrompt(
              chatId,
              "awaiting_days",
              activeSession.task_data,
              `⚠️ <b>Invalid Days of Week</b>\n\n` +
                `I couldn't recognize those days.\n` +
                `Please type valid days separated by comma, like:\n` +
                `• <b>Mon, Wed, Fri</b>\n` +
                `• <b>Saturday, Sunday</b>\n` +
                `• <b>Tue, Thu</b>\n\n` +
                `Or tap <b>[ 🌟 Daily (Every Day) ]</b> below:`,
              [
                [{ text: "🌟 Daily (Every Day)", callback_data: "wizard_days:daily" }],
                [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
              ]
            );
            return NextResponse.json({ ok: true });
          }

          const taskData = activeSession.task_data;
          const previousPromptId = taskData.promptMessageId;
          const newTask = await createTask({
            name: taskData.name!,
            type: taskData.type || "timer",
            target_value: taskData.target_value || (taskData.type === "timer" ? 60 : 5000),
            unit: taskData.unit || (taskData.type === "timer" ? "minutes" : "ml"),
            reminder_time: taskData.reminder_time || null,
            target_days: chosenDays,
          });

          await clearWizardSession(chatId);

          if (!newTask) {
            await sendTelegramMessage(
              chatId,
              `⚠️ Could not create task (a task named "${taskData.name}" may already exist).`
            );
            if (previousPromptId) {
              await removeInlineKeyboard(chatId, previousPromptId);
            }
            return NextResponse.json({ ok: true });
          }

          const typeIcon = taskEmoji(newTask);
          const successText =
            `🎉 <b>Task Created Successfully!</b>\n\n` +
            `📌 <b>${newTask.name}</b>\n` +
            `${typeIcon} Type: <b>${newTask.type.toUpperCase()}</b>\n` +
            `🎯 Goal: <b>${formatGoalDisplay(newTask.target_value, newTask.unit)}</b>\n` +
            `⏰ Reminder: <b>${formatReminderTime(newTask.reminder_time)}</b>\n` +
            `📅 Days: <b>${formatScheduleDisplay(getTaskSchedule(newTask))}</b>\n\n` +
            `Type /tasks to view your routines anytime!`;

          const actionButtons: InlineKeyboard = [];
          if (newTask.type === "timer") {
            actionButtons.push([{ text: `▶️ Start ${newTask.name} Now`, callback_data: `start_task:${newTask.id}` }]);
          } else if (newTask.type === "counter") {
            actionButtons.push([{ text: `+ Add Progress`, callback_data: `select_task:${newTask.id}` }]);
          } else if (newTask.type === "tick") {
            actionButtons.push([{ text: `✅ Mark Done for Today`, callback_data: `tick_task:${newTask.id}` }]);
          }
          actionButtons.push([{ text: "📋 View Tasks", callback_data: "menu_tasks" }]);

          await sendTelegramMessage(chatId, successText, actionButtons);
          if (previousPromptId) {
            await removeInlineKeyboard(chatId, previousPromptId);
          }
          return NextResponse.json({ ok: true });
        }
      }

      // =======================================================================
      // 3.5 TYPE-TO-LOG: a bare amount goes to the task you last opened
      // =======================================================================
      const activeTaskId = await getActiveTaskId(chatId);
      if (activeTaskId) {
        const activeTask = await getTaskById(activeTaskId);
        if (activeTask && !activeTask.is_archived) {
          let loggedValue: number | null = null;
          if (activeTask.type === "timer") {
            loggedValue = parseSignedTimerAmount(text);
          } else if (activeTask.type === "counter") {
            loggedValue = parseSignedCountAmount(text);
          }

          if (loggedValue !== null) {
            let applied = loggedValue;
            let clampedFrom: number | null = null;
            let available = 0;

            if (applied < 0) {
              available = await getTodayTaskTotal(activeTask.name);

              if (available <= 0) {
                const detail = await buildTaskDetail(activeTask);
                await sendUiMessage(
                  chatId,
                  `⚠️ <b>${activeTask.name}</b> is already at <b>0</b> — nothing to subtract.\n\n${detail.text}`,
                  detail.keyboard
                );
                return NextResponse.json({ ok: true });
              }

              const maxSubtract = -available;
              if (applied < maxSubtract) {
                clampedFrom = applied;
                applied = maxSubtract;
              }
            }

            const unitLabel = activeTask.type === "timer" ? "mins" : activeTask.unit || "units";

            // Manual timer entries can never exceed the day's remaining
            // unaccounted time, so the day's total can never pass elapsed.
            if (applied > 0 && activeTask.type === "timer") {
              const activeTimer = await getActiveTimer(chatId);
              const pauseState = await getPauseState(chatId);
              const running = activeTimer
                ? {
                    taskName: activeTimer.task_name,
                    startedAtMs: new Date(activeTimer.started_at).getTime(),
                    pausedAtMs: pauseState.pausedAt,
                    pausedSeconds: pauseState.pausedSeconds,
                  }
                : null;
              const [vacantDay] = computeWastedDays({
                dates: [localDateString()],
                logs: await getTodayLogs(),
                tasks: await getActiveTasks(),
                running,
              });
              const vacant = Math.max(0, vacantDay?.wastedMin ?? 0);

              if (applied > vacant) {
                const detail = await buildTaskDetail(activeTask);
                await sendUiMessage(
                  chatId,
                  `⚠️ Only <b>${formatTimerMinutes(vacant)}</b> of unaccounted time left today ` +
                    `(you tried <b>${formatTimerMinutes(applied)}</b>).\n\n${detail.text}`,
                  detail.keyboard
                );
                return NextResponse.json({ ok: true });
              }
            }

            const newLog = await logActivity({
              task_id: activeTask.id,
              task_name: activeTask.name,
              value: applied,
              notes:
                applied < 0
                  ? `Manual correction ${applied}${activeTask.type === "timer" ? "m" : ""}`
                  : activeTask.type === "timer"
                  ? `Typed log +${applied}m`
                  : "Typed log",
            });

            const detail = await buildTaskDetail(activeTask);
            let text: string;
            let keyboard = detail.keyboard;

            if (applied < 0) {
              text = `✅ <b>${applied.toLocaleString()} ${unitLabel}</b> correction applied to <b>${activeTask.name}</b>.`;
              if (clampedFrom !== null) {
                text += `\n<i>Only ${available} available — you tried ${clampedFrom}.</i>`;
              }
            } else {
              text =
                activeTask.type === "timer"
                  ? `✅ <b>+${formatTimerMinutes(applied)}</b> logged for <b>${activeTask.name}</b>.`
                  : `✅ <b>+${applied.toLocaleString()} ${unitLabel}</b> logged for <b>${activeTask.name}</b>.`;
              if (newLog?.id && !isSystemTask(activeTask)) {
                text += FOCUS_QUESTION;
                keyboard = buildReviewKeyboard(newLog.id);
              } else {
                keyboard = BACK_ONLY_KEYBOARD;
              }
            }
            await sendUiMessage(chatId, `${text}\n\n${detail.text}`, keyboard);
            return NextResponse.json({ ok: true });
          }
        }
      }

      // =======================================================================
      // 4. NO CONTEXT: any other typed message is deleted silently.
      //    AI is only used for /log summaries and /ask analytics.
      // =======================================================================
      if (messageId) {
        await deleteTelegramMessage(chatId, messageId);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Webhook processing error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

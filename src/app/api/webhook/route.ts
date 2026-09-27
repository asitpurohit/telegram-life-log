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
  getTodayTaskFocus,
  createTodo,
  getTodos,
  getTodoById,
  setTodoDone,
  deleteTodo,
} from "@/lib/supabase";
import { parseUserMessageWithAI, isQuickGibberishCheck, AIParsedIntent } from "@/lib/ai";
import { askAboutData } from "@/lib/analytics";
import { buildTimerView, formatDuration, NUDGE_INTERVAL_MS } from "@/lib/timerRuntime";
import { computeWastedDays, formatTimerMinutes, shiftDateString } from "@/lib/timeAudit";
import { localDateLabel, localTimeString, localDateString, localDateShort, zonedDateTimeToUtc, todoDueLabel } from "@/lib/time";
import { TaskType, Task, WizardSession, Todo } from "@/lib/types";

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
    data.startsWith("timer_stop:")
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
    data.startsWith("todo_time:")
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

// Format "HH:MM:SS" to readable "08:00 AM"
function formatReminderTime(timeStr?: string | null): string {
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
function formatGoalDisplay(targetValue?: number | null, unit?: string | null): string {
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

// Task detail view (used by /tasks and as the reply target for typed amounts)
async function buildTaskDetail(task: Task): Promise<{ text: string; keyboard: InlineKeyboard }> {
  if (task.type === "timer") {
    const todayMins = await getTodayTaskTotal(task.name);
    const target = task.target_value || 60;
    const percent = Math.min(100, Math.round((todayMins / target) * 100));
    return {
      text:
        `${taskEmoji(task)} <b>${task.name}</b>\n` +
        `🎯 Daily Goal: <b>${formatGoalDisplay(target, "minutes")}</b>\n` +
        `📅 Schedule: <b>${formatScheduleDisplay(getTaskSchedule(task))}</b>\n` +
        `📊 Today's Progress: <b>${formatTimerMinutes(todayMins)} / ${formatTimerMinutes(target)}</b> (${percent}%)\n\n` +
        `Start the stopwatch, or just type the minutes to log (e.g. <b>45</b>):`,
      keyboard: [
        [{ text: `▶️ Start Live Stopwatch`, callback_data: `start_task:${task.id}` }],
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

// One-line task summary used in edit/delete confirmations
function buildTaskSummary(task: Task): string {
  const typeIcon = taskEmoji(task);
  return (
    `${typeIcon} <b>${task.name}</b>\n` +
    `🎯 Goal: <b>${formatGoalDisplay(task.target_value, task.unit)}</b>\n` +
    `⏰ Reminder: <b>${formatReminderTime(task.reminder_time)}</b>\n` +
    `📅 Days: <b>${formatScheduleDisplay(getTaskSchedule(task))}</b>`
  );
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

function formatFocusBadge(totals: { focused: number; casual: number; distracted: number; tagged: number }): string {
  if (!totals.tagged) return "";
  const pct = (v: number) => Math.round((v / totals.tagged) * 100);
  return ` [🎯 ${pct(totals.focused)}% · 😐 ${pct(totals.casual)}% · 😵 ${pct(totals.distracted)}%]`;
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

// Build a clean, unbloated Today Scorecard
async function buildTodayScorecard(chatId: string | number): Promise<string> {
  const todayStr = localDateLabel();

  const tasks = await getActiveTasks();
  let text = `📊 <b>Today's Scorecard</b> — ${todayStr}\n\n`;

  if (tasks.length === 0) {
    text += `<i>No tasks created yet. Type /addtask to create one!</i>\n`;
  } else {
    text += `<b>Habits & Routines:</b>\n`;
    for (const t of tasks) {
      const isScheduledToday = isTaskScheduledForToday(t.target_days);
      const scheduleTag = !isScheduledToday ? ` <i>(Off today: ${formatScheduleDisplay(t.target_days)})</i>` : "";

      if (t.type === "tick") {
        const isDone = await isTaskCompletedToday(t.id);
        text += `${isDone ? "✅" : isScheduledToday ? "📌" : "💤"} <b>${t.name}</b> ${isDone ? "<i>(Done)</i>" : isScheduledToday ? "<i>(Pending)</i>" : scheduleTag}\n`;
      } else if (t.type === "timer") {
        const mins = await getTodayTaskTotal(t.name);
        const target = t.target_value || 60;
        const pct = Math.min(100, Math.round((mins / target) * 100));
        const focusBadge = formatFocusBadge(await getTodayTaskFocus(t.name));
        text += `${taskEmoji(t)} <b>${t.name}:</b> ${formatTimerMinutes(mins)} / ${formatGoalDisplay(target, "minutes")} (${pct}%)${focusBadge}${scheduleTag}\n`;
      } else {
        const val = await getTodayTaskTotal(t.name);
        const target = t.target_value || 5000;
        const pct = Math.min(100, Math.round((val / target) * 100));
        const focusBadge = formatFocusBadge(await getTodayTaskFocus(t.name));
        text += `💧 <b>${t.name}:</b> ${val.toLocaleString()} / ${formatGoalDisplay(target, t.unit)} (${pct}%)${focusBadge}${scheduleTag}\n`;
      }
    }
  }

  const today = localDateString();
  const logs = await getLogsInRange(shiftDateString(today, -1), today);

  // Wasted = elapsed (midnight -> now) - tracked timer sessions (Sleep included).
  // A running session counts live; a missed night counts as wasted (no estimates).
  if (tasks.length > 0) {
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

    const [day] = computeWastedDays({ dates: [today], logs, tasks, running });
    if (day) {
      const sleepLabel = day.tracked ? `😴 ${formatTimerMinutes(day.sleepMin)}` : "😴 not tracked";

      text += `\n🕳️ <b>Wasted:</b> ${formatTimerMinutes(day.wastedMin)} of ${formatTimerMinutes(day.elapsedMin)} <i>(${sleepLabel} · ⏱️ ${formatTimerMinutes(day.taskMin)} tasks)</i>\n`;
    }
  }

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

// =========================================================================
// MAIN WEBHOOK HANDLER
// =========================================================================

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // =========================================================================
    // SECURITY GUARD: Allow ONLY the authorized user ID (Asit)
    // =========================================================================
    const allowedUserId = process.env.ALLOWED_TELEGRAM_USER_ID;
    const senderId = String(body.message?.from?.id || body.callback_query?.from?.id || "");
    const chatId = body.message?.chat?.id || body.callback_query?.message?.chat?.id;

    if (allowedUserId && senderId && senderId !== allowedUserId) {
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          "🔒 <b>Access Denied:</b> This is a private life-log assistant for Asit only."
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
        const kb: InlineKeyboard = [
          ...buildFocusKeyboard(logId, value),
          [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
        ];
        await respondUi(chatId, messageId, `✅ <b>Session focus saved:</b> ${label}`, kb);
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
        const newTask = await createTask({
          name: taskData.name,
          type: taskData.type || "timer",
          target_value: taskData.target_value || (taskData.type === "timer" ? 60 : 5000),
          unit: taskData.unit || (taskData.type === "timer" ? "minutes" : "ml"),
          reminder_time: taskData.reminder_time || null,
          target_days: chosenDays,
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

      // --- Button: Show Task List (CLEAN - ONLY TASKS) ---
      if (callbackData === "menu_tasks") {
        await setActiveTask(chatId, null);
        const tasks = await getActiveTasks();
        if (tasks.length === 0) {
          await sendTelegramMessage(
            chatId,
            "📋 <b>No tasks created yet!</b>\nType /addtask to create your first routine."
          );
          return NextResponse.json({ ok: true });
        }

        const taskButtons: InlineKeyboard = [];
        for (const t of tasks) {
          if (t.type === "tick") {
            const isDone = await isTaskCompletedToday(t.id);
            taskButtons.push([
              {
                text: `${isDone ? "✅" : "📌"} ${t.name}${isDone ? " (Done)" : ""}`,
                callback_data: `select_task:${t.id}`,
              },
            ]);
          } else if (t.type === "timer") {
            const todayMins = await getTodayTaskTotal(t.name);
            taskButtons.push([
              {
                text: `${taskEmoji(t)} ${t.name} (${formatTimerMinutes(todayMins)} / ${formatGoalDisplay(t.target_value, "minutes")})`,
                callback_data: `select_task:${t.id}`,
              },
            ]);
          } else {
            const todayCount = await getTodayTaskTotal(t.name);
            taskButtons.push([
              {
                text: `💧 ${t.name} (${todayCount.toLocaleString()} / ${formatGoalDisplay(t.target_value, t.unit)})`,
                callback_data: `select_task:${t.id}`,
              },
            ]);
          }
        }

        const tasksText = "📋 <b>Your Tasks:</b>\nTap a task to log or start:";
        await respondUi(chatId, messageId, tasksText, taskButtons);
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

        await setActiveTask(chatId, task.id);
        const detail = await buildTaskDetail(task);
        await respondUi(chatId, messageId, detail.text, detail.keyboard);
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
        const editKb: InlineKeyboard = [
          firstRow,
          [
            { text: "⏰ Reminder", callback_data: `edit_field:${task.id}:reminder` },
            { text: "📅 Days", callback_data: `edit_field:${task.id}:days` },
          ],
          [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
        ];

        const text =
          `📝 <b>Edit "${task.name}"</b>\n\n` +
          `${buildTaskSummary(task)}\n\n` +
          `What would you like to change?`;

        await respondUi(chatId, messageId, text, editKb);
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

        const replyKb: InlineKeyboard = newLog?.id
          ? buildReviewKeyboard(newLog.id)
          : BACK_ONLY_KEYBOARD;

        const text =
          `${task ? taskEmoji(task) : "⏱️"} <b>+${formatTimerMinutes(mins)} logged for ${taskName}!</b>\n\n` +
          `📊 Today's Total: <b>${newTotal} / ${target} mins</b> (${percent}% of daily goal)` +
          (newLog?.id ? FOCUS_QUESTION : "");

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

        const active = await startActiveTimer(chatId, taskId, taskName);
        await clearPauseState(chatId);
        await clearNudgeState(chatId);
        await setActiveTask(chatId, taskId);

        const startedAt = active?.started_at || new Date().toISOString();
        const view = buildTimerView(taskName, startedAt, 0);
        await respondUi(chatId, messageId, view.text, view.keyboard);

        const timerMsgId = messageId ?? (await getTrackedUiMessage(chatId));
        if (timerMsgId) {
          await trackTimerMessage(chatId, timerMsgId);
        }
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

        const view = buildTimerView(active.task_name, active.started_at, pausedAt, pause.pausedSeconds);
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
        if (pausedAt > 0) {
          pausedSeconds += Math.max(0, Math.round((Date.now() - pausedAt) / 1000));
        }
        await setPauseState(chatId, { pausedAt: null, pausedSeconds });

        // Nudge interval restarts from the resume moment
        const nudge = await getNudgeState(chatId);
        if (nudge.messageId) {
          await deleteTelegramMessage(chatId, nudge.messageId);
        }
        await setNudgeState(chatId, { messageId: null, nextNudgeAt: Date.now() + NUDGE_INTERVAL_MS });

        const view = buildTimerView(active.task_name, active.started_at, 0, pausedSeconds);
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
        const view = buildTimerView(
          active.task_name,
          active.started_at,
          pause.pausedAt ?? fallbackPausedAt,
          pause.pausedSeconds
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

      // --- Timer: Stop & Log (paused time excluded; only write of the session) ---
      if (callbackData.startsWith("timer_stop:") || callbackData === "stop_active_timer") {
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

        // Sessions under 5 minutes skip the review entirely (and Sleep never asks for focus)
        const showReview = !!result.logId && result.durationSeconds >= 300 && !isSystemTask(task);
        const stopKb: InlineKeyboard = showReview
          ? buildReviewKeyboard(result.logId as string)
          : BACK_ONLY_KEYBOARD;

        const text =
          `🎉 <b>${result.taskName} Session Completed!</b>\n\n` +
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

      // While a timer is running (or paused), EVERYTHING except answers to an
      // already-open wizard is ignored and removed, so the timer's
      // Pause / Stop / Refresh buttons are the only active surface.
      const activeSession = await getWizardSession(chatId);
      const isWizardAnswer = activeSession && !text.startsWith("/");
      if (!isWizardAnswer) {
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
        const welcomeText =
          `👋 <b>Welcome to your Personal Habit & Life-Log Assistant!</b>\n\n` +
          `<b>Available Commands:</b>\n` +
          `• <b>/tasks</b> — 📋 View routines, start timer, or log counts\n` +
          `• <b>/todo</b> — 📝 One-time to-dos with date & time\n` +
          `• <b>/log</b> — 📖 Write daily diary & mood reflection\n` +
          `• <b>/today</b> — 📊 Daily scorecard & habits progress\n` +
          `• <b>/ask</b> — 🤖 Ask AI about your data & progress\n` +
          `• <b>/addtask</b> — ➕ Create a new habit (guided wizard)\n` +
          `• <b>/edit</b> — ✏️ Edit or delete tasks\n\n` +
          `Type any command above or tap <b>/</b> on your keyboard to begin!`;

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

      // --- Command: /tasks or /task (CLEAN - ONLY TASKS) ---
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

        const taskButtons: InlineKeyboard = [];
        for (const t of tasks) {
          if (t.type === "tick") {
            const isDone = await isTaskCompletedToday(t.id);
            taskButtons.push([
              {
                text: `${isDone ? "✅" : "📌"} ${t.name}${isDone ? " (Done)" : ""}`,
                callback_data: `select_task:${t.id}`,
              },
            ]);
          } else if (t.type === "timer") {
            const todayMins = await getTodayTaskTotal(t.name);
            taskButtons.push([
              {
                text: `${taskEmoji(t)} ${t.name} (${formatTimerMinutes(todayMins)} / ${formatGoalDisplay(t.target_value, "minutes")})`,
                callback_data: `select_task:${t.id}`,
              },
            ]);
          } else {
            const todayCount = await getTodayTaskTotal(t.name);
            taskButtons.push([
              {
                text: `💧 ${t.name} (${todayCount.toLocaleString()} / ${formatGoalDisplay(t.target_value, t.unit)})`,
                callback_data: `select_task:${t.id}`,
              },
            ]);
          }
        }

        await sendUiMessage(chatId, "📋 <b>Your Tasks:</b>\nTap a task to log or start:", taskButtons);
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

      // --- Command: /status (graceful fallback: timer if running, else scorecard) ---
      if (text === "/status") {
        await setActiveTask(chatId, null);
        const active = await getActiveTimer(chatId);
        if (active) {
          const pause = await getPauseState(chatId);
          const view = buildTimerView(
            active.task_name,
            active.started_at,
            pause.pausedAt ?? 0,
            pause.pausedSeconds
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

          const customKb: InlineKeyboard = customLog?.id
            ? buildReviewKeyboard(customLog.id)
            : BACK_ONLY_KEYBOARD;
          await sendUiMessage(
            chatId,
            `⏱️ <b>+${formatTimerMinutes(num)} logged for ${taskName}!</b>\n\n` +
              `📊 Today's Total: <b>${newTotal} / ${target} mins</b> (${percent}% of daily goal)` +
              (customLog?.id ? FOCUS_QUESTION : ""),
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
              if (newLog?.id) {
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

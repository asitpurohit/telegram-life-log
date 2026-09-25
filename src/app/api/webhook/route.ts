import { NextRequest, NextResponse } from "next/server";
import {
  sendTelegramMessage,
  editTelegramMessage,
  answerCallbackQuery,
  removeInlineKeyboard,
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
  stopActiveTimer,
  logActivity,
  getTodayTaskTotal,
  getTodayLogs,
  getWizardSession,
  saveWizardSession,
  clearWizardSession,
  isTaskCompletedToday,
  untickTaskToday,
  deduplicateTodayTickLogs,
  getTaskSchedule,
  formatScheduleDisplay,
  isTaskScheduledForToday,
} from "@/lib/supabase";
import { parseUserMessageWithAI } from "@/lib/ai";
import { TaskType, Task, WizardSession } from "@/lib/types";

export const dynamic = "force-dynamic";

// =========================================================================
// WIZARD PROMPT TRACKING
// Old Telegram prompts keep their inline buttons forever, so every wizard
// prompt stores its message id: stale taps are rejected and the previous
// prompt's keyboard is removed as soon as the flow advances.
// =========================================================================

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
    data.startsWith("edit_set_days:")
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

  await saveWizardSession(chatId, step, { ...taskData, promptMessageId });
}

async function clearWizardSessionAndRetirePrompt(chatId: string | number): Promise<void> {
  const session = await getWizardSession(chatId);
  const promptId = session?.task_data?.promptMessageId;
  await clearWizardSession(chatId);
  if (promptId) {
    await removeInlineKeyboard(chatId, promptId);
  }
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
    const hours = Math.floor(targetValue / 60);
    const mins = targetValue % 60;
    if (hours > 0 && mins > 0) return `${hours}h ${mins}m (${targetValue} mins)`;
    if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""}`;
    return `${mins} mins`;
  }
  if (cleanUnit === "status") {
    return "1 completion";
  }
  return `${targetValue.toLocaleString()} ${cleanUnit || "units"}`;
}

// One-line task summary used in edit/delete confirmations
function buildTaskSummary(task: Task): string {
  const typeIcon = task.type === "timer" ? "⏱️" : task.type === "counter" ? "💧" : "✅";
  return (
    `${typeIcon} <b>${task.name}</b>\n` +
    `🎯 Goal: <b>${formatGoalDisplay(task.target_value, task.unit)}</b>\n` +
    `⏰ Reminder: <b>${formatReminderTime(task.reminder_time)}</b>\n` +
    `📅 Days: <b>${formatScheduleDisplay(getTaskSchedule(task))}</b>`
  );
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

// Build a clean, unbloated Today Scorecard
async function buildTodayScorecard(): Promise<string> {
  const todayStr = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    day: "numeric",
    month: "short",
  });

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
        text += `${isDone ? "✅" : isScheduledToday ? "⬜" : "💤"} <b>${t.name}</b> ${isDone ? "<i>(Done)</i>" : isScheduledToday ? "<i>(Pending)</i>" : scheduleTag}\n`;
      } else if (t.type === "timer") {
        const mins = await getTodayTaskTotal(t.name);
        const target = t.target_value || 60;
        const pct = Math.min(100, Math.round((mins / target) * 100));
        text += `⏱️ <b>${t.name}:</b> ${mins} / ${formatGoalDisplay(target, "minutes")} (${pct}%)${scheduleTag}\n`;
      } else {
        const val = await getTodayTaskTotal(t.name);
        const target = t.target_value || 5000;
        const pct = Math.min(100, Math.round((val / target) * 100));
        text += `💧 <b>${t.name}:</b> ${val.toLocaleString()} / ${formatGoalDisplay(target, t.unit)} (${pct}%)${scheduleTag}\n`;
      }
    }
  }

  const logs = await getTodayLogs();
  const diaryLogs = logs.filter((l) => l.task_name === "Diary");
  if (diaryLogs.length > 0) {
    text += `\n📖 <b>Today's Diary:</b>\n`;
    for (const d of diaryLogs) {
      const timeStr = d.created_at
        ? new Date(d.created_at).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
      text += `• ${timeStr ? `<i>[${timeStr}]</i> ` : ""}${d.notes}\n`;
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
      }

      // Acknowledge receipt to remove button loading spinner on phone
      await answerCallbackQuery(callbackQuery.id);

      // --- WIZARD: Cancel Active Action ---
      if (callbackData === "wizard_cancel") {
        await clearWizardSession(chatId);
        const cancelText = "❌ <i>Action cancelled.</i>";
        if (messageId) {
          await editTelegramMessage(chatId, messageId, cancelText, []);
        } else {
          await sendTelegramMessage(chatId, cancelText);
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
        const previousPromptId = taskData.promptMessageId;
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
          await sendTelegramMessage(chatId, `⚠️ Could not create task (name may already exist).`);
          if (previousPromptId && previousPromptId !== messageId) {
            await removeInlineKeyboard(chatId, previousPromptId);
          }
          return NextResponse.json({ ok: true });
        }

        const typeIcon = newTask.type === "timer" ? "⏱️" : newTask.type === "counter" ? "💧" : "✅";
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

        if (messageId) {
          await editTelegramMessage(chatId, messageId, successText, actionButtons);
        } else {
          await sendTelegramMessage(chatId, successText, actionButtons);
        }
        if (previousPromptId && previousPromptId !== messageId) {
          await removeInlineKeyboard(chatId, previousPromptId);
        }
        return NextResponse.json({ ok: true });
      }

      // --- Button: Show Task List (CLEAN - ONLY TASKS) ---
      if (callbackData === "menu_tasks") {
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
                text: `${isDone ? "✅" : "⬜"} ${t.name}${isDone ? " (Done)" : ""}`,
                callback_data: `select_task:${t.id}`,
              },
            ]);
          } else if (t.type === "timer") {
            const todayMins = await getTodayTaskTotal(t.name);
            taskButtons.push([
              {
                text: `⏱️ ${t.name} (${todayMins}m / ${formatGoalDisplay(t.target_value, "minutes")})`,
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
        if (messageId) {
          await editTelegramMessage(chatId, messageId, tasksText, taskButtons);
        } else {
          await sendTelegramMessage(chatId, tasksText, taskButtons);
        }
        return NextResponse.json({ ok: true });
      }

      // --- Button: Selected a Task (Clean, Dedicated Actions) ---
      if (callbackData.startsWith("select_task:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        if (!task) {
          await sendTelegramMessage(chatId, "⚠️ Task not found or already archived.");
          return NextResponse.json({ ok: true });
        }

        if (task.type === "timer") {
          const todayMins = await getTodayTaskTotal(task.name);
          const target = task.target_value || 60;
          const percent = Math.min(100, Math.round((todayMins / target) * 100));

          const timerKeyboard: InlineKeyboard = [
            [{ text: `▶️ Start Live Stopwatch`, callback_data: `start_task:${task.id}` }],
            [
              { text: "+15m", callback_data: `timer_add:${task.id}:15` },
              { text: "+30m", callback_data: `timer_add:${task.id}:30` },
              { text: "+60m", callback_data: `timer_add:${task.id}:60` },
            ],
            [
              { text: "✏️ Custom Minutes", callback_data: `timer_custom_prompt:${task.id}` },
              { text: "📋 Back to Tasks", callback_data: "menu_tasks" },
            ],
            [
              { text: "📝 Edit", callback_data: `edit_task:${task.id}` },
              { text: "🗑️ Delete", callback_data: `delete_task:${task.id}` },
            ],
          ];

          await sendTelegramMessage(
            chatId,
            `⏱️ <b>${task.name}</b>\n` +
              `🎯 Daily Goal: <b>${formatGoalDisplay(target, "minutes")}</b>\n` +
              `📅 Schedule: <b>${formatScheduleDisplay(getTaskSchedule(task))}</b>\n` +
              `📊 Today's Progress: <b>${todayMins} / ${target} mins</b> (${percent}%)\n\n` +
              `Choose how to track this session:`,
            timerKeyboard
          );
        } else if (task.type === "counter") {
          const todayTotal = await getTodayTaskTotal(task.name);
          const target = task.target_value || 5000;
          const percent = Math.min(100, Math.round((todayTotal / target) * 100));
          const unit = task.unit || "units";

          const counterKeyboard: InlineKeyboard = [
            [
              { text: `+1 ${unit}`, callback_data: `counter_add:${task.id}:1` },
              { text: `+5 ${unit}`, callback_data: `counter_add:${task.id}:5` },
              { text: `+10 ${unit}`, callback_data: `counter_add:${task.id}:10` },
            ],
            [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
            [
              { text: "📝 Edit", callback_data: `edit_task:${task.id}` },
              { text: "🗑️ Delete", callback_data: `delete_task:${task.id}` },
            ],
          ];

          await sendTelegramMessage(
            chatId,
            `💧 <b>${task.name}</b>\n` +
              `🎯 Goal: <b>${formatGoalDisplay(target, unit)}</b>\n` +
              `📅 Schedule: <b>${formatScheduleDisplay(getTaskSchedule(task))}</b>\n` +
              `📊 Today: <b>${todayTotal.toLocaleString()} / ${formatGoalDisplay(target, unit)}</b> (${percent}%)\n\n` +
              `Log progress:`,
            counterKeyboard
          );
        } else if (task.type === "tick") {
          const isDone = await isTaskCompletedToday(task.id);
          if (isDone) {
            const tickKeyboard: InlineKeyboard = [
              [{ text: `⭕ Mark Incomplete (Undo)`, callback_data: `untick_task:${task.id}` }],
              [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
              [
                { text: "📝 Edit", callback_data: `edit_task:${task.id}` },
                { text: "🗑️ Delete", callback_data: `delete_task:${task.id}` },
              ],
            ];
            await sendTelegramMessage(
              chatId,
              `✅ <b>${task.name}</b> is marked complete for today!\nTap below if you want to undo:`,
              tickKeyboard
            );
          } else {
            const tickKeyboard: InlineKeyboard = [
              [{ text: `✅ Mark Done for Today`, callback_data: `tick_task:${task.id}` }],
              [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
              [
                { text: "📝 Edit", callback_data: `edit_task:${task.id}` },
                { text: "🗑️ Delete", callback_data: `delete_task:${task.id}` },
              ],
            ];
            await sendTelegramMessage(
              chatId,
              `⬜ <b>${task.name}</b>\nSchedule: <b>${formatScheduleDisplay(getTaskSchedule(task))}</b>\nReady to mark complete:`,
              tickKeyboard
            );
          }
        }
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

        const confirmKb: InlineKeyboard = [
          [{ text: "🗑️ Yes, Delete", callback_data: `confirm_delete:${task.id}` }],
          [{ text: "❌ Cancel", callback_data: `delete_cancel:${task.id}` }],
        ];
        const text =
          `🗑️ <b>Delete "${task.name}"?</b>\n\n` +
          `It will be removed from your task list.\n` +
          `📜 Past logs stay saved forever.`;

        if (messageId) {
          await editTelegramMessage(chatId, messageId, text, confirmKb);
        } else {
          await sendTelegramMessage(chatId, text, confirmKb);
        }
        return NextResponse.json({ ok: true });
      }

      // --- Button: Cancel Delete ---
      if (callbackData.startsWith("delete_cancel:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        const text = task
          ? `❌ <i>Delete cancelled — <b>${task.name}</b> is safe.</i>`
          : `❌ <i>Delete cancelled.</i>`;
        if (messageId) {
          await editTelegramMessage(chatId, messageId, text, [
            [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
          ]);
        } else {
          await sendTelegramMessage(chatId, text);
        }
        return NextResponse.json({ ok: true });
      }

      // --- Button: Confirm Delete ---
      if (callbackData.startsWith("confirm_delete:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        if (!task) {
          await sendTelegramMessage(chatId, "⚠️ Task already deleted.");
          return NextResponse.json({ ok: true });
        }

        await archiveTask(task.id);

        const text =
          `🗑️ <b>${task.name}</b> removed from your task list.\n\n` +
          `📜 Past logs are untouched — your history is safe.\n` +
          `💡 Create a task with the same name anytime to revive it.`;
        const kb: InlineKeyboard = [[{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }]];

        if (messageId) {
          await editTelegramMessage(chatId, messageId, text, kb);
        } else {
          await sendTelegramMessage(chatId, text, kb);
        }
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

        const firstRow = [{ text: "📝 Name", callback_data: `edit_field:${task.id}:name` }];
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

        if (messageId) {
          await editTelegramMessage(chatId, messageId, text, editKb);
        } else {
          await sendTelegramMessage(chatId, text, editKb);
        }
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
        if (messageId) {
          await editTelegramMessage(chatId, messageId, text, [
            [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
          ]);
        } else {
          await sendTelegramMessage(chatId, text);
        }
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
        if (messageId) {
          await editTelegramMessage(chatId, messageId, text, [
            [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
          ]);
        } else {
          await sendTelegramMessage(chatId, text);
        }
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

        await logActivity({
          task_id: taskId,
          task_name: taskName,
          value: mins,
          notes: `Manual log +${mins}m`,
        });

        const newTotal = await getTodayTaskTotal(taskName);
        const percent = Math.round((newTotal / target) * 100);

        const replyKb: InlineKeyboard = [
          [{ text: `▶️ Start Live Stopwatch`, callback_data: `start_task:${taskId}` }],
          [
            { text: "+15m", callback_data: `timer_add:${taskId}:15` },
            { text: "+30m", callback_data: `timer_add:${taskId}:30` },
          ],
          [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
        ];

        const text =
          `⏱️ <b>+${mins} mins logged for ${taskName}!</b>\n\n` +
          `📊 Today's Total: <b>${newTotal} / ${target} mins</b> (${percent}% of daily goal)`;

        if (messageId) {
          await editTelegramMessage(chatId, messageId, text, replyKb);
        } else {
          await sendTelegramMessage(chatId, text, replyKb);
        }
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

      // --- Button: Start Timer ---
      if (callbackData.startsWith("start_task:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        const taskName = task ? task.name : "Study/Work";

        await startActiveTimer(chatId, taskId, taskName);

        const stopKeyboard: InlineKeyboard = [
          [{ text: `⏹️ End & Log ${taskName}`, callback_data: "stop_active_timer" }],
        ];

        const text = `⏱️ <b>${taskName}</b> timer started at <b>${new Date().toLocaleTimeString()}</b>!\nFocus mode on. Tap Stop when finished:`;

        if (messageId) {
          await editTelegramMessage(chatId, messageId, text, stopKeyboard);
        } else {
          await sendTelegramMessage(chatId, text, stopKeyboard);
        }
        return NextResponse.json({ ok: true });
      }

      // --- Button: Stop Active Timer ---
      if (callbackData === "stop_active_timer") {
        const result = await stopActiveTimer(chatId);
        if (!result) {
          await sendTelegramMessage(chatId, "⏱️ No active timer was running.");
          return NextResponse.json({ ok: true });
        }

        const task = await findTaskByName(result.taskName);
        const totalToday = await getTodayTaskTotal(result.taskName);
        const target = task?.target_value || 60;
        const percent = Math.round((totalToday / target) * 100);

        const stopKb: InlineKeyboard = [
          [{ text: `▶️ Start ${result.taskName} Again`, callback_data: `start_task:${result.taskId}` }],
          [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
        ];

        const text =
          `🎉 <b>${result.taskName} Session Completed!</b>\n\n` +
          `⏱️ This Session: <b>+${result.durationMinutes} minutes</b>\n` +
          `📊 Today's Total: <b>${totalToday} / ${target} minutes</b> (${percent}% of daily goal)\n\n` +
          `Saved cleanly to your database!`;

        if (messageId) {
          await editTelegramMessage(chatId, messageId, text, stopKb);
        } else {
          await sendTelegramMessage(chatId, text, stopKb);
        }
        return NextResponse.json({ ok: true });
      }

      // --- Button: Counter Add (Generic) ---
      if (callbackData.startsWith("counter_add:")) {
        const [, taskId, amountStr] = callbackData.split(":");
        const amount = parseInt(amountStr, 10);
        const task = await getTaskById(taskId);
        const taskName = task ? task.name : "Habit";

        await logActivity({
          task_id: taskId,
          task_name: taskName,
          value: amount,
        });

        const total = await getTodayTaskTotal(taskName);
        const target = task?.target_value || 5000;
        const percent = Math.min(100, Math.round((total / target) * 100));

        const replyKb: InlineKeyboard = [
          [
            { text: `+1 ${task?.unit || "units"}`, callback_data: `counter_add:${taskId}:1` },
            { text: `+5 ${task?.unit || "units"}`, callback_data: `counter_add:${taskId}:5` },
            { text: `+10 ${task?.unit || "units"}`, callback_data: `counter_add:${taskId}:10` },
          ],
          [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
        ];

        const text =
          `💧 <b>${taskName}</b>: Logged +${amount} ${task?.unit || ""}!\n` +
          `📊 Today: <b>${total.toLocaleString()} / ${formatGoalDisplay(target, task?.unit)}</b> (${percent}%)`;

        if (messageId) {
          await editTelegramMessage(chatId, messageId, text, replyKb);
        } else {
          await sendTelegramMessage(chatId, text, replyKb);
        }
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
            notes: `Completed at ${new Date().toLocaleTimeString()}`,
          });
        }
        await deduplicateTodayTickLogs(taskId);

        const undoKeyboard: InlineKeyboard = [
          [{ text: `↩️ Undo (Mark Incomplete)`, callback_data: `untick_task:${taskId}` }],
          [{ text: "📋 Back to Tasks", callback_data: "menu_tasks" }],
        ];

        const text = `✅ <b>${taskName}</b> marked as completed for today!`;
        if (messageId) {
          await editTelegramMessage(chatId, messageId, text, undoKeyboard);
        } else {
          await sendTelegramMessage(chatId, text, undoKeyboard);
        }
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
        if (messageId) {
          await editTelegramMessage(chatId, messageId, text, tickKeyboard);
        } else {
          await sendTelegramMessage(chatId, text, tickKeyboard);
        }
        return NextResponse.json({ ok: true });
      }
    }

    // =========================================================================
    // 2. HANDLE TEXT MESSAGES (Dedicated Commands, Wizard Steps, Diary)
    // =========================================================================
    if (body.message?.text) {
      const text = body.message.text.trim();
      const chatId = body.message.chat.id;

      // --- Command: /cancel ---
      if (text === "/cancel") {
        await clearWizardSessionAndRetirePrompt(chatId);
        await sendTelegramMessage(chatId, "❌ <i>Action cancelled.</i>");
        return NextResponse.json({ ok: true });
      }

      // --- Command: /start ---
      if (text === "/start") {
        await clearWizardSessionAndRetirePrompt(chatId);
        const welcomeText =
          `👋 <b>Welcome to your Personal Habit & Life-Log Assistant!</b>\n\n` +
          `<b>Available Commands:</b>\n` +
          `• <b>/addtask</b> — ➕ Create a new task (guided wizard)\n` +
          `• <b>/tasks</b> — 📋 View and log your tasks\n` +
          `• <b>/today</b> — 📊 View today's scorecard\n` +
          `• <b>/log</b> — 📖 Write daily diary / notes\n` +
          `• <b>/status</b> — ⏱️ Check or stop active timer\n` +
          `• <b>/cancel</b> — ❌ Cancel current action\n\n` +
          `Type any command above or tap <b>/</b> on your keyboard to begin!`;

        await sendTelegramMessage(chatId, welcomeText);
        return NextResponse.json({ ok: true });
      }

      // --- Command: /log or /diary (Dedicated Diary Command) ---
      if (text.startsWith("/log") || text.startsWith("/diary")) {
        const noteContent = text.replace(/^\/(log|diary)\s*/i, "").trim();

        if (noteContent.length >= 3) {
          const ai = await parseUserMessageWithAI(noteContent, []);
          await logActivity({
            task_name: "Diary",
            notes: noteContent,
            value: 1,
          });

          const summary = ai.diary?.summary || noteContent.slice(0, 120);
          let reply = `📖 <b>Diary Saved for Today!</b>\n\n📝 <b>Summary:</b> ${summary}`;

          if (ai.diary?.projects && ai.diary.projects.length > 0) {
            reply += `\n🎯 <b>Projects:</b> ${ai.diary.projects.join(", ")}`;
          }
          if (ai.diary?.people && ai.diary.people.length > 0) {
            reply += `\n👥 <b>People:</b> ${ai.diary.people.join(", ")}`;
          }
          if (ai.diary?.decisions && ai.diary.decisions.length > 0) {
            reply += `\n💡 <b>Decisions:</b> ${ai.diary.decisions.join(", ")}`;
          }

          await sendTelegramMessage(chatId, reply);
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
        const typeKeyboard: InlineKeyboard = [
          [
            { text: "⏱️ Timer", callback_data: "wizard_type:timer" },
            { text: "💧 Counter", callback_data: "wizard_type:counter" },
            { text: "✅ Daily Tick", callback_data: "wizard_type:tick" },
          ],
          [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
        ];

        const promptText =
          `➕ <b>Create a New Task</b>\n\n` +
          `What kind of task is this?\n` +
          `• ⏱️ <b>Timer:</b> Study, coding, workout (time goal in hours & minutes)\n` +
          `• 💧 <b>Counter:</b> Amount & unit goal (e.g. 10 km, 5000 ml, 50 pages)\n` +
          `• ✅ <b>Daily Tick:</b> Wake up, meditation (yes/no daily completion)`;

        await sendTelegramMessage(chatId, promptText, typeKeyboard);
        return NextResponse.json({ ok: true });
      }

      // --- Command: /tasks or /task (CLEAN - ONLY TASKS) ---
      if (text === "/tasks" || text === "/task") {
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
                text: `${isDone ? "✅" : "⬜"} ${t.name}${isDone ? " (Done)" : ""}`,
                callback_data: `select_task:${t.id}`,
              },
            ]);
          } else if (t.type === "timer") {
            const todayMins = await getTodayTaskTotal(t.name);
            taskButtons.push([
              {
                text: `⏱️ ${t.name} (${todayMins}m / ${formatGoalDisplay(t.target_value, "minutes")})`,
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

        await sendTelegramMessage(chatId, "📋 <b>Your Tasks:</b>\nTap a task to log or start:", taskButtons);
        return NextResponse.json({ ok: true });
      }

      // --- Command: /status ---
      if (text === "/status") {
        const active = await getActiveTimer(chatId);
        if (!active) {
          await sendTelegramMessage(chatId, "⏱️ <i>No timer currently running.</i>");
        } else {
          const startedAt = new Date(active.started_at);
          const elapsed = Math.round((Date.now() - startedAt.getTime()) / 60000);
          await sendTelegramMessage(
            chatId,
            `⏱️ Running: <b>${active.task_name}</b> for <b>${elapsed} mins</b>\n(Started: ${startedAt.toLocaleTimeString()})`,
            [[{ text: "⏹️ End & Log", callback_data: "stop_active_timer" }]]
          );
        }
        return NextResponse.json({ ok: true });
      }

      // --- Command: /today ---
      if (text === "/today") {
        const scorecard = await buildTodayScorecard();
        await sendTelegramMessage(chatId, scorecard);
        return NextResponse.json({ ok: true });
      }

      // =======================================================================
      // 3. CONVERSATIONAL WIZARD STATE HANDLER
      // =======================================================================
      const activeSession = await getWizardSession(chatId);

      if (activeSession) {
        // --- State: User Answering Diary Prompt ---
        if (activeSession.step === "awaiting_diary_text") {
          const diaryPromptId = activeSession.task_data.promptMessageId;
          await clearWizardSession(chatId);
          const ai = await parseUserMessageWithAI(text, []);

          await logActivity({
            task_name: "Diary",
            notes: text,
            value: 1,
          });

          const summary = ai.diary?.summary || text.slice(0, 120);
          let reply = `📖 <b>Diary Saved for Today!</b>\n\n📝 <b>Summary:</b> ${summary}`;

          if (ai.diary?.projects && ai.diary.projects.length > 0) {
            reply += `\n🎯 <b>Projects:</b> ${ai.diary.projects.join(", ")}`;
          }
          if (ai.diary?.people && ai.diary.people.length > 0) {
            reply += `\n👥 <b>People:</b> ${ai.diary.people.join(", ")}`;
          }
          if (ai.diary?.decisions && ai.diary.decisions.length > 0) {
            reply += `\n💡 <b>Decisions:</b> ${ai.diary.decisions.join(", ")}`;
          }

          await sendTelegramMessage(chatId, reply);
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

          await logActivity({
            task_id: taskId || null,
            task_name: taskName,
            value: num,
            notes: `Manual log +${num}m`,
          });

          const customPromptId = activeSession.task_data.promptMessageId;
          await clearWizardSession(chatId);

          const newTotal = await getTodayTaskTotal(taskName);
          const percent = Math.round((newTotal / target) * 100);

          await sendTelegramMessage(
            chatId,
            `⏱️ <b>+${num} mins logged for ${taskName}!</b>\n\n` +
              `📊 Today's Total: <b>${newTotal} / ${target} mins</b> (${percent}% of daily goal)`
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
            if (newName.length < 2) {
              await failEdit("⚠️ Please provide a name with at least 2 characters:");
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
          const editPromptId = activeSession.task_data.promptMessageId;
          await clearWizardSession(chatId);

          await sendTelegramMessage(
            chatId,
            `✅ <b>Task Updated!</b>\n\n${updated ? buildTaskSummary(updated) : ""}`
          );
          if (editPromptId) {
            await removeInlineKeyboard(chatId, editPromptId);
          }
          return NextResponse.json({ ok: true });
        }

        // --- State: Step 1 Name Input -> Branch by Task Type ---
        if (activeSession.step === "awaiting_name") {
          const taskName = text.trim();
          if (taskName.length < 2) {
            await sendWizardPrompt(
              chatId,
              "awaiting_name",
              activeSession.task_data,
              "⚠️ Please provide a task name with at least 2 characters:",
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

          const typeIcon = newTask.type === "timer" ? "⏱️" : newTask.type === "counter" ? "💧" : "✅";
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
      // 4. FREEFORM MESSAGE HANDLING (NO ACCIDENTAL DIARY SAVES)
      // =======================================================================
      const activeTasks = await getActiveTasks();
      const taskNames = activeTasks.map((t) => t.name);

      const ai = await parseUserMessageWithAI(text, taskNames);

      // AI Intent: CREATE A TASK VIA TEXT (e.g. "Add task: Read books")
      if (ai.intent === "CREATE_TASK" && ai.task) {
        if (!ai.task.name || ai.task.name.trim().length < 2) {
          await sendTelegramMessage(
            chatId,
            `💡 <b>To create a task, type /addtask</b>`
          );
          return NextResponse.json({ ok: true });
        }
        const newTask = await createTask({
          name: ai.task.name,
          type: ai.task.type,
          reminder_time: ai.task.reminder_time || null,
          target_value: ai.task.target_value || (ai.task.type === "timer" ? 60 : 5000),
          unit: ai.task.unit || (ai.task.type === "timer" ? "minutes" : "ml"),
        });

        if (newTask) {
          await sendTelegramMessage(
            chatId,
            `✅ <b>Created ${newTask.type.toUpperCase()} Task:</b>\n` +
              `📌 <b>${newTask.name}</b>\n` +
              `🎯 Goal: <b>${formatGoalDisplay(newTask.target_value, newTask.unit)}</b>\n` +
              `${newTask.reminder_time ? `⏰ Reminder: ${formatReminderTime(newTask.reminder_time)}\n` : ""}` +
              `\nYou can start it anytime via /tasks!`
          );
        } else {
          await sendTelegramMessage(chatId, `⚠️ Could not create task (might already exist).`);
        }
        return NextResponse.json({ ok: true });
      }

      // AI Intent: START TIMER (e.g. "Starting physics now")
      if (ai.intent === "START_TIMER") {
        const targetName = ai.timerTaskName || "Study/Work";
        const matchedTask = await findTaskByName(targetName);
        const taskId = matchedTask ? matchedTask.id : "ad-hoc";
        const taskName = matchedTask ? matchedTask.name : targetName;

        await startActiveTimer(chatId, taskId, taskName);
        await sendTelegramMessage(
          chatId,
          `⏱️ <b>${taskName}</b> timer started at <b>${new Date().toLocaleTimeString()}</b>!\nFocus mode on:`,
          [[{ text: `⏹️ End & Log ${taskName}`, callback_data: "stop_active_timer" }]]
        );
        return NextResponse.json({ ok: true });
      }

      // AI Intent: STOP TIMER
      if (ai.intent === "STOP_TIMER") {
        const result = await stopActiveTimer(chatId);
        if (!result) {
          await sendTelegramMessage(chatId, "⏱️ No active timer was running.");
        } else {
          const task = await findTaskByName(result.taskName);
          const totalToday = await getTodayTaskTotal(result.taskName);
          const target = task?.target_value || 60;
          const percent = Math.round((totalToday / target) * 100);

          await sendTelegramMessage(
            chatId,
            `🎉 <b>${result.taskName}</b> finished!\n` +
              `⏱️ This Session: <b>+${result.durationMinutes} mins</b>\n` +
              `📊 Today's Total: <b>${totalToday} / ${target} mins</b> (${percent}% of goal)`
          );
        }
        return NextResponse.json({ ok: true });
      }

      // AI Intent: ADD WATER (e.g. "Drank 500ml water")
      if (ai.intent === "ADD_WATER") {
        const amount = ai.waterAmount || 500;
        await logActivity({
          task_name: "Drink Water",
          value: amount,
          notes: `Logged via message`,
        });
        const total = await getTodayTaskTotal("Drink Water");
        await sendTelegramMessage(
          chatId,
          `💧 <b>+${amount}ml logged!</b> Today: <b>${total.toLocaleString()}/5,000ml</b>`
        );
        return NextResponse.json({ ok: true });
      }

      // CASUAL CHAT / QUESTIONS / TYPOS (CLEAN)
      await sendTelegramMessage(
        chatId,
        ai.replyMessage ||
          `👋 I received: <i>"${text}"</i>\n\n` +
            `<b>Commands:</b>\n` +
            `• <b>/tasks</b> — View your task list\n` +
            `• <b>/today</b> — View today's scorecard\n` +
            `• <b>/addtask</b> — Create a new task\n` +
            `• <b>/log</b> — Write your daily diary\n` +
            `• <b>/status</b> — Check active timer`
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Webhook processing error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

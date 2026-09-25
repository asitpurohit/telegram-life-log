import { NextRequest, NextResponse } from "next/server";
import {
  sendTelegramMessage,
  editTelegramMessage,
  answerCallbackQuery,
  InlineKeyboard,
} from "@/lib/telegram";
import {
  getActiveTasks,
  getTaskById,
  findTaskByName,
  createTask,
  startActiveTimer,
  getActiveTimer,
  stopActiveTimer,
  logActivity,
  getTodayTaskTotal,
  getTodayLogs,
  getWizardSession,
  saveWizardSession,
  clearWizardSession,
} from "@/lib/supabase";
import { parseUserMessageWithAI } from "@/lib/ai";
import { TaskType } from "@/lib/types";

export const dynamic = "force-dynamic";

// Standard Quick Action Keyboard shown on /start
const MAIN_MENU_KEYBOARD: InlineKeyboard = [
  [
    { text: "➕ Add Task", callback_data: "start_wizard" },
    { text: "📋 My Tasks", callback_data: "menu_tasks" },
  ],
  [
    { text: "💧 +500ml Water", callback_data: "water_add:500" },
    { text: "⏱️ Active Timer", callback_data: "timer_status" },
  ],
  [
    { text: "📊 Today's Scorecard", callback_data: "menu_today" },
  ],
];

// Helper: Parse natural time input (e.g. "8am", "08:00 AM", "18:30", "8:30 pm") to "HH:MM:SS"
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

// Helper: Format "HH:MM:SS" to readable "08:00 AM"
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

      // Acknowledge receipt to remove button loading spinner on phone
      await answerCallbackQuery(callbackQuery.id);

      // --- WIZARD: Cancel Active Creation ---
      if (callbackData === "wizard_cancel") {
        await clearWizardSession(chatId);
        const cancelText = "❌ <i>Task creation cancelled.</i>";
        if (messageId) {
          await editTelegramMessage(chatId, messageId, cancelText, MAIN_MENU_KEYBOARD);
        } else {
          await sendTelegramMessage(chatId, cancelText, MAIN_MENU_KEYBOARD);
        }
        return NextResponse.json({ ok: true });
      }

      // --- WIZARD: Start Task Creation (/addtask or button) ---
      if (callbackData === "start_wizard") {
        await clearWizardSession(chatId);
        const typeKeyboard: InlineKeyboard = [
          [
            { text: "⏱️ Timer", callback_data: "wizard_type:timer" },
            { text: "💧 Counter", callback_data: "wizard_type:counter" },
            { text: "✅ Daily Tick", callback_data: "wizard_type:tick" },
          ],
          [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
        ];

        const text =
          `➕ <b>Create a New Task (Step 1 of 4)</b>\n\n` +
          `Choose the type of task you want to track:\n` +
          `• ⏱️ <b>Timer:</b> For study, coding, work (tracks minutes)\n` +
          `• 💧 <b>Counter:</b> For water, pages, reps (tracks quantity)\n` +
          `• ✅ <b>Daily Tick:</b> For wake up, routines (done once a day)`;

        await sendTelegramMessage(chatId, text, typeKeyboard);
        return NextResponse.json({ ok: true });
      }

      // --- WIZARD: Step 1 Selected Type -> Prompt for Name ---
      if (callbackData.startsWith("wizard_type:")) {
        const type = callbackData.split(":")[1] as TaskType;
        await saveWizardSession(chatId, "awaiting_name", { type });

        const typeLabels: Record<TaskType, string> = {
          timer: "⏱️ Timer (Study, Work, Exercise)",
          counter: "💧 Counter (Water, Reps, Pages)",
          tick: "✅ Daily Tick (Wake Up, Checklist)",
        };

        const promptText =
          `📝 <b>Step 2 of 4: Task Name</b>\n\n` +
          `Type: <b>${typeLabels[type] || type}</b>\n\n` +
          `Please type the name of this task:\n` +
          `<i>(e.g., "Physics Study", "Read Books", "Morning Meditation")</i>`;

        const cancelKb: InlineKeyboard = [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]];

        if (messageId) {
          await editTelegramMessage(chatId, messageId, promptText, cancelKb);
        } else {
          await sendTelegramMessage(chatId, promptText, cancelKb);
        }
        return NextResponse.json({ ok: true });
      }

      // --- WIZARD: Step 3 Skip Reminder ---
      if (callbackData === "wizard_skip:reminder") {
        const session = await getWizardSession(chatId);
        if (!session) {
          await sendTelegramMessage(chatId, "⚠️ No active task creation in progress.", MAIN_MENU_KEYBOARD);
          return NextResponse.json({ ok: true });
        }

        const taskData = { ...session.task_data, reminder_time: null };
        await saveWizardSession(chatId, "awaiting_target", taskData);

        const type = taskData.type || "timer";
        let targetPrompt = "";
        let skipButtonText = "⏭️ Skip Target";

        if (type === "timer") {
          targetPrompt =
            `🎯 <b>Step 4 of 4: Daily Goal</b>\n\n` +
            `Task: <b>${taskData.name}</b>\n` +
            `Reminder: <i>None (Skipped)</i>\n\n` +
            `How many <b>minutes</b> is your daily goal?\n` +
            `<i>(e.g., 30, 45, 60, 120)</i>\n\n` +
            `Or tap <b>Skip</b> for default (60 mins):`;
          skipButtonText = "⏭️ Skip (Default: 60 mins)";
        } else if (type === "counter") {
          targetPrompt =
            `🎯 <b>Step 4 of 4: Daily Goal</b>\n\n` +
            `Task: <b>${taskData.name}</b>\n` +
            `Reminder: <i>None (Skipped)</i>\n\n` +
            `What is your daily target amount?\n` +
            `<i>(e.g., 5000 for water, 20 for reading pages)</i>\n\n` +
            `Or tap <b>Skip</b> for default:`;
          skipButtonText = "⏭️ Skip (Default: 5000)";
        } else {
          targetPrompt =
            `🎯 <b>Step 4 of 4: Confirm Task</b>\n\n` +
            `Task: <b>${taskData.name}</b>\n` +
            `Reminder: <i>None (Skipped)</i>\n\n` +
            `Daily Tick tasks are marked complete once per day.\n` +
            `Tap below to save:`;
          skipButtonText = "✅ Confirm & Save";
        }

        const targetKb: InlineKeyboard = [
          [{ text: skipButtonText, callback_data: "wizard_skip:target" }],
          [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
        ];

        if (messageId) {
          await editTelegramMessage(chatId, messageId, targetPrompt, targetKb);
        } else {
          await sendTelegramMessage(chatId, targetPrompt, targetKb);
        }
        return NextResponse.json({ ok: true });
      }

      // --- WIZARD: Step 4 Skip / Confirm Target -> Finalize Task ---
      if (callbackData === "wizard_skip:target" || callbackData === "wizard_confirm:tick") {
        const session = await getWizardSession(chatId);
        if (!session || !session.task_data.name) {
          await sendTelegramMessage(chatId, "⚠️ Task session expired. Please type /addtask to start again.");
          return NextResponse.json({ ok: true });
        }

        const type = session.task_data.type || "timer";
        const taskName = session.task_data.name;
        const reminderTime = session.task_data.reminder_time || null;

        let targetValue = 60;
        let unit = "minutes";

        if (type === "timer") {
          targetValue = 60;
          unit = "minutes";
        } else if (type === "counter") {
          targetValue = taskName.toLowerCase().includes("water") ? 5000 : 10;
          unit = taskName.toLowerCase().includes("water") ? "ml" : "units";
        } else if (type === "tick") {
          targetValue = 1;
          unit = "status";
        }

        const newTask = await createTask({
          name: taskName,
          type,
          reminder_time: reminderTime,
          target_value: targetValue,
          unit,
        });

        await clearWizardSession(chatId);

        if (!newTask) {
          await sendTelegramMessage(chatId, `⚠️ Could not create task (a task named "${taskName}" may already exist).`);
          return NextResponse.json({ ok: true });
        }

        const typeIcon = type === "timer" ? "⏱️" : type === "counter" ? "💧" : "✅";
        const successText =
          `🎉 <b>Task Created Successfully!</b>\n\n` +
          `📌 <b>${newTask.name}</b>\n` +
          `${typeIcon} Type: <b>${newTask.type.toUpperCase()}</b>\n` +
          `⏰ Reminder: <b>${formatReminderTime(newTask.reminder_time)}</b>\n` +
          `🎯 Daily Goal: <b>${newTask.target_value} ${newTask.unit}</b>\n\n` +
          `You can now start tracking anytime:`;

        const actionButtons: InlineKeyboard = [];
        if (newTask.type === "timer") {
          actionButtons.push([{ text: `▶️ Start ${newTask.name} Now`, callback_data: `start_task:${newTask.id}` }]);
        } else if (newTask.type === "counter") {
          actionButtons.push([{ text: `💧 Log +500 ${newTask.unit}`, callback_data: `counter_add:${newTask.id}:500` }]);
        } else if (newTask.type === "tick") {
          actionButtons.push([{ text: `✅ Mark Done for Today`, callback_data: `tick_task:${newTask.id}` }]);
        }

        actionButtons.push([
          { text: "📋 View Tasks", callback_data: "menu_tasks" },
          { text: "➕ Add Another Task", callback_data: "start_wizard" },
        ]);

        if (messageId) {
          await editTelegramMessage(chatId, messageId, successText, actionButtons);
        } else {
          await sendTelegramMessage(chatId, successText, actionButtons);
        }
        return NextResponse.json({ ok: true });
      }

      // --- Button: Show Task List ---
      if (callbackData === "menu_tasks") {
        const tasks = await getActiveTasks();
        if (tasks.length === 0) {
          await sendTelegramMessage(
            chatId,
            "📋 <b>No tasks created yet!</b>\nTap below to create your first task:",
            [[{ text: "➕ Add Task", callback_data: "start_wizard" }]]
          );
          return NextResponse.json({ ok: true });
        }

        const taskButtons: InlineKeyboard = tasks.map((t) => {
          let icon = "⏱️";
          if (t.type === "counter") icon = "💧";
          if (t.type === "tick") icon = "✅";
          return [{ text: `${icon} ${t.name}`, callback_data: `select_task:${t.id}` }];
        });

        taskButtons.push([{ text: "➕ Add New Task", callback_data: "start_wizard" }]);

        await sendTelegramMessage(chatId, "📋 <b>Select a task to start or log:</b>", taskButtons);
        return NextResponse.json({ ok: true });
      }

      // --- Button: Selected a Task ---
      if (callbackData.startsWith("select_task:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        if (!task) {
          await sendTelegramMessage(chatId, "⚠️ Task not found or already archived.");
          return NextResponse.json({ ok: true });
        }

        if (task.type === "timer") {
          const timerKeyboard: InlineKeyboard = [
            [{ text: `▶️ Start ${task.name}`, callback_data: `start_task:${task.id}` }],
          ];
          await sendTelegramMessage(
            chatId,
            `⏱️ <b>${task.name}</b> (Target: ${task.target_value || 60} mins)\nReady to begin?`,
            timerKeyboard
          );
        } else if (task.type === "counter") {
          const counterKeyboard: InlineKeyboard = [
            [
              { text: "💧 +250ml", callback_data: `counter_add:${task.id}:250` },
              { text: "💧 +500ml", callback_data: `counter_add:${task.id}:500` },
            ],
          ];
          await sendTelegramMessage(
            chatId,
            `💧 <b>${task.name}</b> (Target: ${task.target_value || 5000} ${task.unit || "ml"})\nLog an amount:`,
            counterKeyboard
          );
        } else if (task.type === "tick") {
          const tickKeyboard: InlineKeyboard = [
            [{ text: `✅ Done with ${task.name}`, callback_data: `tick_task:${task.id}` }],
          ];
          await sendTelegramMessage(chatId, `✅ <b>${task.name}</b>:`, tickKeyboard);
        }
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
          await sendTelegramMessage(chatId, "⚠️ No active timer was found.");
          return NextResponse.json({ ok: true });
        }

        const text = `🎉 <b>${result.taskName} Session Completed!</b>\n⏱️ Duration logged: <b>${result.durationMinutes} minutes</b>\nSaved cleanly to your database!`;
        if (messageId) {
          await editTelegramMessage(chatId, messageId, text, MAIN_MENU_KEYBOARD);
        } else {
          await sendTelegramMessage(chatId, text, MAIN_MENU_KEYBOARD);
        }
        return NextResponse.json({ ok: true });
      }

      // --- Button: Check Active Timer Status ---
      if (callbackData === "timer_status") {
        const active = await getActiveTimer(chatId);
        if (!active) {
          await sendTelegramMessage(
            chatId,
            "⏱️ <i>No timer currently running.</i>",
            MAIN_MENU_KEYBOARD
          );
        } else {
          const startedAt = new Date(active.started_at);
          const elapsed = Math.round((Date.now() - startedAt.getTime()) / 60000);
          await sendTelegramMessage(
            chatId,
            `⏱️ Active: <b>${active.task_name}</b>\nRunning for <b>${elapsed} minutes</b> (Started: ${startedAt.toLocaleTimeString()})`,
            [[{ text: "⏹️ End & Log", callback_data: "stop_active_timer" }]]
          );
        }
        return NextResponse.json({ ok: true });
      }

      // --- Button: Add Water ---
      if (callbackData.startsWith("water_add:")) {
        const amount = parseInt(callbackData.split(":")[1], 10) || 500;
        await logActivity({
          task_name: "Drink Water",
          value: amount,
          notes: `Added ${amount}ml`,
        });

        const todayTotal = await getTodayTaskTotal("Drink Water");
        const goal = 5000;
        const percent = Math.min(100, Math.round((todayTotal / goal) * 100));

        await sendTelegramMessage(
          chatId,
          `💧 <b>+${amount}ml Logged!</b>\nToday's Total: <b>${todayTotal} / ${goal} ml</b> (${percent}% of goal)`
        );
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
        await sendTelegramMessage(
          chatId,
          `💧 <b>${taskName}</b>: Logged +${amount}!\nTotal today: <b>${total} ${task?.unit || ""}</b>`
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Tick Task ---
      if (callbackData.startsWith("tick_task:")) {
        const taskId = callbackData.split(":")[1];
        const task = await getTaskById(taskId);
        const taskName = task ? task.name : "Routine";

        await logActivity({
          task_id: taskId,
          task_name: taskName,
          value: 1,
          notes: `Completed at ${new Date().toLocaleTimeString()}`,
        });

        await sendTelegramMessage(
          chatId,
          `✅ <b>${taskName}</b> marked as completed for today!`
        );
        return NextResponse.json({ ok: true });
      }

      // --- Button: Today's Scorecard ---
      if (callbackData === "menu_today") {
        const logs = await getTodayLogs();
        if (logs.length === 0) {
          await sendTelegramMessage(chatId, "📊 <i>No activities logged yet today. Ready to start!</i>", MAIN_MENU_KEYBOARD);
          return NextResponse.json({ ok: true });
        }

        let summary = "📊 <b>Today's Activity Log:</b>\n\n";
        for (const log of logs) {
          if (log.task_name === "Diary") {
            summary += `📖 <b>Diary:</b> ${log.notes?.slice(0, 80)}...\n`;
          } else {
            summary += `• <b>${log.task_name}:</b> ${log.value} ${log.notes ? `(${log.notes})` : ""}\n`;
          }
        }

        await sendTelegramMessage(chatId, summary, MAIN_MENU_KEYBOARD);
        return NextResponse.json({ ok: true });
      }
    }

    // =========================================================================
    // 2. HANDLE TEXT MESSAGES (Commands, Wizard Steps, Freeform AI)
    // =========================================================================
    if (body.message?.text) {
      const text = body.message.text.trim();
      const chatId = body.message.chat.id;

      // --- Command: /cancel ---
      if (text === "/cancel") {
        await clearWizardSession(chatId);
        await sendTelegramMessage(
          chatId,
          "❌ <i>Task creation cancelled.</i>",
          MAIN_MENU_KEYBOARD
        );
        return NextResponse.json({ ok: true });
      }

      // --- Command: /start ---
      if (text === "/start") {
        await clearWizardSession(chatId);
        await sendTelegramMessage(
          chatId,
          `👋 <b>Welcome to your Personal AI Life-Log Assistant!</b>\n\n` +
            `• Type <b>/addtask</b> (or click slash /) to create a new task.\n` +
            `• Tap buttons below for fast tracking.\n` +
            `• Type naturally to log your <b>daily diary</b>.\n` +
            `• Say <i>"Starting physics study"</i> anytime to track a timer.`,
          MAIN_MENU_KEYBOARD
        );
        return NextResponse.json({ ok: true });
      }

      // --- Command: /addtask ---
      if (text === "/addtask") {
        await clearWizardSession(chatId);
        const typeKeyboard: InlineKeyboard = [
          [
            { text: "⏱️ Timer", callback_data: "wizard_type:timer" },
            { text: "💧 Counter", callback_data: "wizard_type:counter" },
            { text: "✅ Daily Tick", callback_data: "wizard_type:tick" },
          ],
          [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
        ];

        const promptText =
          `➕ <b>Create a New Task (Step 1 of 4)</b>\n\n` +
          `Choose the type of task you want to track:\n` +
          `• ⏱️ <b>Timer:</b> For study, coding, work (tracks minutes)\n` +
          `• 💧 <b>Counter:</b> For water, pages, reps (tracks quantity)\n` +
          `• ✅ <b>Daily Tick:</b> For wake up, routines (done once a day)`;

        await sendTelegramMessage(chatId, promptText, typeKeyboard);
        return NextResponse.json({ ok: true });
      }

      // --- Command: /tasks ---
      if (text === "/tasks") {
        const tasks = await getActiveTasks();
        if (tasks.length === 0) {
          await sendTelegramMessage(
            chatId,
            "📋 <b>No tasks created yet!</b>\nTap below to create one:",
            [[{ text: "➕ Add Task", callback_data: "start_wizard" }]]
          );
          return NextResponse.json({ ok: true });
        }

        const taskButtons: InlineKeyboard = tasks.map((t) => [
          {
            text: `${t.type === "timer" ? "⏱️" : t.type === "counter" ? "💧" : "✅"} ${t.name}`,
            callback_data: `select_task:${t.id}`,
          },
        ]);
        taskButtons.push([{ text: "➕ Add New Task", callback_data: "start_wizard" }]);

        await sendTelegramMessage(chatId, "📋 <b>Active Tasks & Routines:</b>", taskButtons);
        return NextResponse.json({ ok: true });
      }

      // --- Command: /status ---
      if (text === "/status") {
        const active = await getActiveTimer(chatId);
        if (!active) {
          await sendTelegramMessage(chatId, "⏱️ No timer currently running.", MAIN_MENU_KEYBOARD);
        } else {
          const startedAt = new Date(active.started_at);
          const elapsed = Math.round((Date.now() - startedAt.getTime()) / 60000);
          await sendTelegramMessage(
            chatId,
            `⏱️ Running: <b>${active.task_name}</b> for ${elapsed} mins`,
            [[{ text: "⏹️ End & Log", callback_data: "stop_active_timer" }]]
          );
        }
        return NextResponse.json({ ok: true });
      }

      // --- Command: /today ---
      if (text === "/today") {
        const logs = await getTodayLogs();
        if (logs.length === 0) {
          await sendTelegramMessage(chatId, "📊 <i>No activities logged yet today. Ready to start!</i>", MAIN_MENU_KEYBOARD);
          return NextResponse.json({ ok: true });
        }

        let summary = "📊 <b>Today's Activity Log:</b>\n\n";
        for (const log of logs) {
          if (log.task_name === "Diary") {
            summary += `📖 <b>Diary:</b> ${log.notes?.slice(0, 80)}...\n`;
          } else {
            summary += `• <b>${log.task_name}:</b> ${log.value} ${log.notes ? `(${log.notes})` : ""}\n`;
          }
        }

        await sendTelegramMessage(chatId, summary, MAIN_MENU_KEYBOARD);
        return NextResponse.json({ ok: true });
      }

      // =======================================================================
      // 3. CONVERSATIONAL WIZARD STATE HANDLER
      // =======================================================================
      const activeSession = await getWizardSession(chatId);

      if (activeSession) {
        // --- Step 2: User Typed Task Name ---
        if (activeSession.step === "awaiting_name") {
          const taskName = text;
          if (taskName.length < 2) {
            await sendTelegramMessage(
              chatId,
              "⚠️ Please provide a name with at least 2 characters:",
              [[{ text: "❌ Cancel", callback_data: "wizard_cancel" }]]
            );
            return NextResponse.json({ ok: true });
          }

          const updatedData = { ...activeSession.task_data, name: taskName };
          await saveWizardSession(chatId, "awaiting_reminder", updatedData);

          const reminderPrompt =
            `⏰ <b>Step 3 of 4: Daily Reminder Time</b>\n\n` +
            `Task: <b>${taskName}</b>\n\n` +
            `What time would you like a daily reminder?\n` +
            `<i>(e.g., "08:00 AM", "8am", or "18:30")</i>\n\n` +
            `Or tap <b>Skip Reminder</b> below:`;

          const reminderKb: InlineKeyboard = [
            [{ text: "⏭️ Skip Reminder", callback_data: "wizard_skip:reminder" }],
            [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
          ];

          await sendTelegramMessage(chatId, reminderPrompt, reminderKb);
          return NextResponse.json({ ok: true });
        }

        // --- Step 3: User Typed Reminder Time ---
        if (activeSession.step === "awaiting_reminder") {
          const parsedTime = parseReminderTime(text);
          if (!parsedTime) {
            await sendTelegramMessage(
              chatId,
              `⚠️ I didn't recognize that time format.\n\n` +
                `Please try formats like <b>08:00 AM</b>, <b>8am</b>, or <b>18:30</b>.\n` +
                `Or tap <b>Skip Reminder</b> below:`,
              [
                [{ text: "⏭️ Skip Reminder", callback_data: "wizard_skip:reminder" }],
                [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
              ]
            );
            return NextResponse.json({ ok: true });
          }

          const updatedData = { ...activeSession.task_data, reminder_time: parsedTime };
          await saveWizardSession(chatId, "awaiting_target", updatedData);

          const type = updatedData.type || "timer";
          let targetPrompt = "";
          let skipButtonText = "⏭️ Skip Target";

          if (type === "timer") {
            targetPrompt =
              `🎯 <b>Step 4 of 4: Daily Goal</b>\n\n` +
              `Task: <b>${updatedData.name}</b>\n` +
              `Reminder: <b>${formatReminderTime(parsedTime)}</b>\n\n` +
              `How many <b>minutes</b> is your daily goal?\n` +
              `<i>(e.g., 30, 45, 60, 120)</i>\n\n` +
              `Or tap <b>Skip</b> for default (60 mins):`;
            skipButtonText = "⏭️ Skip (Default: 60 mins)";
          } else if (type === "counter") {
            targetPrompt =
              `🎯 <b>Step 4 of 4: Daily Goal</b>\n\n` +
              `Task: <b>${updatedData.name}</b>\n` +
              `Reminder: <b>${formatReminderTime(parsedTime)}</b>\n\n` +
              `What is your daily target amount?\n` +
              `<i>(e.g., 5000 for water, 20 for pages)</i>\n\n` +
              `Or tap <b>Skip</b> for default:`;
            skipButtonText = "⏭️ Skip (Default: 5000)";
          } else {
            targetPrompt =
              `🎯 <b>Step 4 of 4: Confirm Task</b>\n\n` +
              `Task: <b>${updatedData.name}</b>\n` +
              `Reminder: <b>${formatReminderTime(parsedTime)}</b>\n\n` +
              `Daily Tick tasks are marked complete once per day.\n` +
              `Tap below to save:`;
            skipButtonText = "✅ Confirm & Save";
          }

          const targetKb: InlineKeyboard = [
            [{ text: skipButtonText, callback_data: "wizard_skip:target" }],
            [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
          ];

          await sendTelegramMessage(chatId, targetPrompt, targetKb);
          return NextResponse.json({ ok: true });
        }

        // --- Step 4: User Typed Daily Target ---
        if (activeSession.step === "awaiting_target") {
          const num = parseInt(text.replace(/[^0-9]/g, ""), 10);
          if (isNaN(num) || num <= 0) {
            await sendTelegramMessage(
              chatId,
              `⚠️ Please enter a valid number (e.g. <b>60</b> or <b>5000</b>) or tap <b>Skip Target</b> below:`,
              [
                [{ text: "⏭️ Skip Target", callback_data: "wizard_skip:target" }],
                [{ text: "❌ Cancel", callback_data: "wizard_cancel" }],
              ]
            );
            return NextResponse.json({ ok: true });
          }

          const type = activeSession.task_data.type || "timer";
          const taskName = activeSession.task_data.name!;
          const reminderTime = activeSession.task_data.reminder_time || null;
          const targetValue = num;
          const unit =
            type === "timer"
              ? "minutes"
              : taskName.toLowerCase().includes("water")
              ? "ml"
              : "units";

          const newTask = await createTask({
            name: taskName,
            type,
            reminder_time: reminderTime,
            target_value: targetValue,
            unit,
          });

          await clearWizardSession(chatId);

          if (!newTask) {
            await sendTelegramMessage(
              chatId,
              `⚠️ Could not create task (a task named "${taskName}" may already exist).`
            );
            return NextResponse.json({ ok: true });
          }

          const typeIcon = type === "timer" ? "⏱️" : type === "counter" ? "💧" : "✅";
          const successText =
            `🎉 <b>Task Created Successfully!</b>\n\n` +
            `📌 <b>${newTask.name}</b>\n` +
            `${typeIcon} Type: <b>${newTask.type.toUpperCase()}</b>\n` +
            `⏰ Reminder: <b>${formatReminderTime(newTask.reminder_time)}</b>\n` +
            `🎯 Daily Goal: <b>${newTask.target_value} ${newTask.unit}</b>\n\n` +
            `You can now start tracking anytime:`;

          const actionButtons: InlineKeyboard = [];
          if (newTask.type === "timer") {
            actionButtons.push([{ text: `▶️ Start ${newTask.name} Now`, callback_data: `start_task:${newTask.id}` }]);
          } else if (newTask.type === "counter") {
            actionButtons.push([{ text: `💧 Log +500 ${newTask.unit}`, callback_data: `counter_add:${newTask.id}:500` }]);
          } else if (newTask.type === "tick") {
            actionButtons.push([{ text: `✅ Mark Done for Today`, callback_data: `tick_task:${newTask.id}` }]);
          }

          actionButtons.push([
            { text: "📋 View Tasks", callback_data: "menu_tasks" },
            { text: "➕ Add Another Task", callback_data: "start_wizard" },
          ]);

          await sendTelegramMessage(chatId, successText, actionButtons);
          return NextResponse.json({ ok: true });
        }
      }

      // =======================================================================
      // 4. FREEFORM AI INTENT PROCESSING
      // =======================================================================
      const activeTasks = await getActiveTasks();
      const taskNames = activeTasks.map((t) => t.name);

      const ai = await parseUserMessageWithAI(text, taskNames);

      // AI Intent: CREATE A TASK VIA TEXT
      if (ai.intent === "CREATE_TASK" && ai.task) {
        if (!ai.task.name || ai.task.name.trim().length < 2) {
          await sendTelegramMessage(
            chatId,
            `💡 <b>To create a task, type /addtask</b> or say:\n` +
              `• <i>"Add timer task: Reading books at 7am for 30 minutes"</i>\n` +
              `• <i>"Add counter task: Drink 5L water"</i>\n` +
              `• <i>"Add tick task: Wake up at 5am"</i>`,
            [[{ text: "➕ Open Add Task Wizard", callback_data: "start_wizard" }]]
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
              `${newTask.reminder_time ? `⏰ Reminder: ${formatReminderTime(newTask.reminder_time)}\n` : ""}` +
              `${newTask.target_value ? `🎯 Goal: ${newTask.target_value} ${newTask.unit}\n` : ""}` +
              `\nYou can start it anytime via /tasks!`,
            [[{ text: `▶️ Start ${newTask.name}`, callback_data: `start_task:${newTask.id}` }]]
          );
        } else {
          await sendTelegramMessage(chatId, `⚠️ Could not create task (might already exist).`);
        }
        return NextResponse.json({ ok: true });
      }

      // AI Intent: START TIMER
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
          await sendTelegramMessage(chatId, "⚠️ No active timer was running.", MAIN_MENU_KEYBOARD);
        } else {
          await sendTelegramMessage(
            chatId,
            `🎉 <b>${result.taskName}</b> finished!\nLogged <b>${result.durationMinutes} minutes</b> to database.`,
            MAIN_MENU_KEYBOARD
          );
        }
        return NextResponse.json({ ok: true });
      }

      // AI Intent: ADD WATER
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
          `💧 <b>+${amount}ml logged!</b> Today: <b>${total}/5000ml</b>`
        );
        return NextResponse.json({ ok: true });
      }

      // AI Intent: DIARY ENTRY
      if (ai.intent === "DIARY_ENTRY") {
        await logActivity({
          task_name: "Diary",
          notes: text,
          value: 1,
        });

        const summary = ai.diary?.summary || text.slice(0, 100);
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
      }

      // AI Intent: QUERY OR FALLBACK
      await sendTelegramMessage(
        chatId,
        ai.replyMessage || "Logged your message! Type /tasks to see your routines or /today to see your scorecard.",
        MAIN_MENU_KEYBOARD
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Webhook processing error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

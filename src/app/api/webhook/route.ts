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
} from "@/lib/supabase";
import { parseUserMessageWithAI } from "@/lib/ai";

export const dynamic = "force-dynamic";

// Standard Quick Action Keyboard shown on /start
const MAIN_MENU_KEYBOARD: InlineKeyboard = [
  [
    { text: "📋 My Tasks", callback_data: "menu_tasks" },
    { text: "💧 +500ml Water", callback_data: "water_add:500" },
  ],
  [
    { text: "⏱️ Check Active Timer", callback_data: "timer_status" },
    { text: "📊 Today's Scorecard", callback_data: "menu_today" },
  ],
];

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

      // --- Button: Show Task List ---
      if (callbackData === "menu_tasks") {
        const tasks = await getActiveTasks();
        if (tasks.length === 0) {
          await sendTelegramMessage(
            chatId,
            "📋 <b>No tasks created yet!</b>\nYou can say: <i>'Remind me to study Physics at 8am'</i> or <i>'Add task: drink 5L water'</i>."
          );
          return NextResponse.json({ ok: true });
        }

        const taskButtons: InlineKeyboard = tasks.map((t) => {
          let icon = "⏱️";
          if (t.type === "counter") icon = "💧";
          if (t.type === "tick") icon = "✅";
          return [{ text: `${icon} ${t.name}`, callback_data: `select_task:${t.id}` }];
        });

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
          await sendTelegramMessage(chatId, "📊 <i>No activities logged yet today. Ready to start!</i>");
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
    // 2. HANDLE TEXT MESSAGES (Commands, AI Diary, Task Creation, Freeform)
    // =========================================================================
    if (body.message?.text) {
      const text = body.message.text.trim();
      const chatId = body.message.chat.id;

      // --- Command: /start ---
      if (text === "/start") {
        await sendTelegramMessage(
          chatId,
          `👋 <b>Welcome to your Personal AI Life-Log & Habit Tracker!</b>\n\n` +
            `• Tap buttons below for fast tracking.\n` +
            `• Type naturally to log your <b>diary</b>.\n` +
            `• Say <i>"Add timer task: Physics at 8am"</i> to schedule new routines.\n` +
            `• Say <i>"Starting physics"</i> anytime to track a session.`,
          MAIN_MENU_KEYBOARD
        );
        return NextResponse.json({ ok: true });
      }

      // --- Command: /tasks ---
      if (text === "/tasks") {
        const tasks = await getActiveTasks();
        if (tasks.length === 0) {
          await sendTelegramMessage(
            chatId,
            "📋 No tasks yet. Try: <i>'Remind me to study Physics at 8am'</i>"
          );
          return NextResponse.json({ ok: true });
        }

        const taskButtons: InlineKeyboard = tasks.map((t) => [
          { text: `${t.type === "timer" ? "⏱️" : t.type === "counter" ? "💧" : "✅"} ${t.name}`, callback_data: `select_task:${t.id}` },
        ]);

        await sendTelegramMessage(chatId, "📋 <b>Active Tasks & Routines:</b>", taskButtons);
        return NextResponse.json({ ok: true });
      }

      // --- Command: /status ---
      if (text === "/status") {
        const active = await getActiveTimer(chatId);
        if (!active) {
          await sendTelegramMessage(chatId, "⏱️ No timer currently running.");
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

      // --- FREEFORM AI PROCESSING ---
      const activeTasks = await getActiveTasks();
      const taskNames = activeTasks.map((t) => t.name);

      const ai = await parseUserMessageWithAI(text, taskNames);

      // AI Intent: CREATE A TASK
      if (ai.intent === "CREATE_TASK" && ai.task) {
        if (!ai.task.name || ai.task.name.trim().length < 2) {
          await sendTelegramMessage(
            chatId,
            `💡 <b>To create a task, say:</b>\n` +
              `• <i>"Add timer task: Reading books at 7am for 30 minutes"</i>\n` +
              `• <i>"Add counter task: Drink 5L water"</i>\n` +
              `• <i>"Add tick task: Wake up at 5am"</i>`
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
              `${newTask.reminder_time ? `⏰ Reminder: ${newTask.reminder_time}\n` : ""}` +
              `${newTask.target_value ? `🎯 Target: ${newTask.target_value} ${newTask.unit}\n` : ""}` +
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
          await sendTelegramMessage(chatId, "⚠️ No active timer was running.");
        } else {
          await sendTelegramMessage(
            chatId,
            `🎉 <b>${result.taskName}</b> finished!\nLogged <b>${result.durationMinutes} minutes</b> to database.`
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
        ai.replyMessage || "Logged your message! Type /tasks to see your routines or /today to see your scorecard."
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Webhook processing error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

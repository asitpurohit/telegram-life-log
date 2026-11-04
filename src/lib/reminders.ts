import {
  supabase,
  isTaskScheduledForToday,
  getDueTodos,
  claimTodoReminder,
  getUserSettings,
  trackDailyReminderMessage,
  getStaleDailyReminderMessages,
  getTrackedUiMessage,
} from "./supabase";
import { sendTelegramMessage, deleteTelegramMessage, InlineKeyboard } from "./telegram";
import { localDateString, localHHMMSS, todoDueLabel } from "./time";
import { buildTodayScorecard } from "./scorecard";
import { sendDailySummaryEmail } from "./dailyEmailSummary";
import { clearIdleAlertCard } from "./idleGuardian";

const MORNING_BRIEFING_TIME = process.env.MORNING_BRIEFING_TIME || "05:00:00";

// DB-backed dedupe (works across serverless invocations): a unique row in
// wizard_sessions acts as a lock so a reminder is sent at most once per day.
async function claimReminderSend(taskId: string, date: string, time: string): Promise<boolean> {
  const { error } = await supabase.from("wizard_sessions").insert({
    chat_id: `__rem__:${taskId}:${date}:${time}`,
    step: "ui_reminder",
    task_data: { sent_at: new Date().toISOString() },
  });

  if (!error) return true;

  if (error.code === "23505") return false; // unique violation -> already sent

  console.error("Reminder dedupe error (sending anyway):", error);
  return true;
}

async function resolveChatId(override?: string | null): Promise<string | null> {
  if (override) return override;
  if (process.env.TELEGRAM_DEFAULT_CHAT_ID) return process.env.TELEGRAM_DEFAULT_CHAT_ID;

  // Fallback for the single-user bot: most recently active chat from tracking rows
  const { data } = await supabase
    .from("wizard_sessions")
    .select("chat_id")
    .like("chat_id", "__%")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const match = data?.chat_id?.match(/^__[a-z_]+__:(.+)$/);
  return match ? match[1] : null;
}

export async function sendDueReminders(
  timeToMatch?: string,
  chatIdOverride?: string | null
): Promise<{ status: string; count: number; tasks: string[]; todos: string[]; time: string }> {
  // Reminder times are stored at minute precision (e.g. "08:00:00")
  const time = timeToMatch || `${localHHMMSS().slice(0, 5)}:00`;
  const targetChatId = await resolveChatId(chatIdOverride);

  if (!targetChatId) {
    return { status: "no_target_chat", count: 0, tasks: [], todos: [], time };
  }

  const sentTasks: string[] = [];

  // 5:00 AM Daily Morning Briefing
  // Fires automatically at 05:00:00 (or on the first tick between 05:00:00 and 12:00:00 if idle)
  const isMorningWindow = time >= MORNING_BRIEFING_TIME && time < "12:00:00";
  if (isMorningWindow) {
    const canSendMorning = await claimReminderSend("__morning_briefing__", localDateString(), "5am");
    if (canSendMorning) {
      try {
        // --- Option 1: Fresh Daily Canvas Cleanup ---
        // 1. Purge yesterday's stale reminder cards & receipts from Telegram
        const staleRows = await getStaleDailyReminderMessages(targetChatId, localDateString());
        for (const stale of staleRows) {
          for (const msgId of stale.messageIds) {
            await deleteTelegramMessage(targetChatId, msgId);
          }
          await supabase.from("wizard_sessions").delete().eq("chat_id", stale.rowKey);
        }

        // 2. Clear any lingering idle alert card from yesterday
        await clearIdleAlertCard(targetChatId);

        // 3. Clear any stale UI menu card from yesterday
        const staleUiMsgId = await getTrackedUiMessage(targetChatId);
        if (staleUiMsgId) {
          await deleteTelegramMessage(targetChatId, staleUiMsgId);
        }

        // 4. Send today's fresh morning scorecard
        const scorecard = await buildTodayScorecard(targetChatId);
        const morningMessage = `☀️ <b>Good Morning! (5:00 AM Daily Plan)</b>\n\n${scorecard}`;
        const morningRes = await sendTelegramMessage(targetChatId, morningMessage);
        if (morningRes?.result?.message_id) {
          await trackDailyReminderMessage(targetChatId, morningRes.result.message_id, localDateString());
        }
        sentTasks.push("Morning 5 AM Briefing (Fresh Canvas)");
      } catch (err: any) {
        console.error("Error sending 5 AM morning briefing:", err);
      }
    }

    // Daily Automated Email Summary for Yesterday (100% Free - Resend / Gmail)
    const canSendEmail = await claimReminderSend("__morning_email__", localDateString(), "email");
    if (canSendEmail) {
      try {
        const userSettings = await getUserSettings(targetChatId);
        const recipient = userSettings.summary_email_to || process.env.SUMMARY_EMAIL_TO;
        const emailResult = await sendDailySummaryEmail(undefined, recipient || undefined);
        if (emailResult.sent) {
          sentTasks.push(`Morning Daily Summary Email (${emailResult.provider})`);
        }
      } catch (err: any) {
        console.error("Error sending morning daily summary email:", err);
      }
    }
  }

  const { data: dueTasks, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("is_archived", false)
    .eq("reminder_time", time);

  if (error) {
    console.error("Error querying reminders:", error);
    return { status: "error", count: 0, tasks: [], todos: [], time };
  }

  for (const task of dueTasks || []) {
    if (!isTaskScheduledForToday(task.target_days)) continue;

    const canSend = await claimReminderSend(task.id, localDateString(), time);
    if (!canSend) continue;

    let text = `⏰ <b>Reminder: ${task.name}!</b>\n`;
    let keyboard: InlineKeyboard = [];

    if (task.type === "timer") {
      text += `Scheduled study/work session (Target: ${task.target_value || 60} mins).\nTap to open the task:`;
      keyboard = [[{ text: `📂 Open ${task.name}`, callback_data: `open_task:${task.id}` }]];
    } else if (task.type === "tick") {
      text += `Scheduled routine.\nTap below when done:`;
      keyboard = [[{ text: `✅ Done with ${task.name}`, callback_data: `tick_task:${task.id}` }]];
    } else {
      const unit = task.unit || "units";
      const unitLower = unit.toLowerCase();
      const quickAmount = unitLower.includes("ml") || unitLower.includes("liter")
        ? 500
        : unitLower.includes("km") || unitLower.includes("mile")
        ? 1
        : unitLower.includes("step")
        ? 1000
        : unitLower.includes("page")
        ? 10
        : 1;

      text += `Goal check-in (Target: ${task.target_value} ${unit}).`;
      keyboard = [
        [{ text: `➕ +${quickAmount} ${unit}`, callback_data: `counter_add:${task.id}:${quickAmount}` }],
      ];
    }

    const remRes = await sendTelegramMessage(targetChatId, text, keyboard);
    if (remRes?.result?.message_id) {
      await trackDailyReminderMessage(targetChatId, remRes.result.message_id, localDateString());
    }
    sentTasks.push(task.name);
  }

  // One-time todos due now (catch-up window handled inside getDueTodos)
  const dueTodos = await getDueTodos(6);
  const sentTodos: string[] = [];

  for (const todo of dueTodos) {
    const claimed = await claimTodoReminder(todo.id);
    if (!claimed) continue;

    const todoRes = await sendTelegramMessage(
      targetChatId,
      `⏰ <b>Todo: ${todo.title}</b>\n` +
        `🕐 ${todoDueLabel(todo.due_at)}\n\n` +
        `Tap below when it's done:`,
      [[{ text: `✅ Done: ${todo.title.slice(0, 30)}`, callback_data: `todo_done:${todo.id}` }]]
    );
    if (todoRes?.result?.message_id) {
      await trackDailyReminderMessage(targetChatId, todoRes.result.message_id, localDateString());
    }
    sentTodos.push(todo.title);
  }

  const total = sentTasks.length + sentTodos.length;

  return {
    status: total > 0 ? "reminders_sent" : "no_reminders_due",
    count: total,
    tasks: sentTasks,
    todos: sentTodos,
    time,
  };
}

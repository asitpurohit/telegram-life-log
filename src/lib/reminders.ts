import { supabase, isTaskScheduledForToday } from "./supabase";
import { sendTelegramMessage, InlineKeyboard } from "./telegram";
import { localDateString, localHHMMSS } from "./time";

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
): Promise<{ status: string; count: number; tasks: string[]; time: string }> {
  // Reminder times are stored at minute precision (e.g. "08:00:00")
  const time = timeToMatch || `${localHHMMSS().slice(0, 5)}:00`;
  const targetChatId = await resolveChatId(chatIdOverride);

  if (!targetChatId) {
    return { status: "no_target_chat", count: 0, tasks: [], time };
  }

  const { data: dueTasks, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("is_archived", false)
    .eq("reminder_time", time);

  if (error) {
    console.error("Error querying reminders:", error);
    return { status: "error", count: 0, tasks: [], time };
  }

  if (!dueTasks || dueTasks.length === 0) {
    return { status: "no_reminders_due", count: 0, tasks: [], time };
  }

  const sentTasks: string[] = [];

  for (const task of dueTasks) {
    if (!isTaskScheduledForToday(task.target_days)) continue;

    const canSend = await claimReminderSend(task.id, localDateString(), time);
    if (!canSend) continue;

    let text = `⏰ <b>Reminder: ${task.name}!</b>\n`;
    let keyboard: InlineKeyboard = [];

    if (task.type === "timer") {
      text += `Scheduled study/work session (Target: ${task.target_value || 60} mins).\nReady to start?`;
      keyboard = [[{ text: `▶️ Start ${task.name}`, callback_data: `start_task:${task.id}` }]];
    } else if (task.type === "tick") {
      text += `Scheduled routine.\nTap below when done:`;
      keyboard = [[{ text: `✅ Done with ${task.name}`, callback_data: `tick_task:${task.id}` }]];
    } else {
      text += `Goal check-in (Target: ${task.target_value} ${task.unit || "units"}).`;
      keyboard = [[{ text: `💧 +500ml`, callback_data: `water_add:500` }]];
    }

    await sendTelegramMessage(targetChatId, text, keyboard);
    sentTasks.push(task.name);
  }

  return {
    status: sentTasks.length > 0 ? "reminders_sent" : "no_reminders_due",
    count: sentTasks.length,
    tasks: sentTasks,
    time,
  };
}

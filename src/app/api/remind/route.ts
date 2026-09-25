import { NextRequest, NextResponse } from "next/server";
import { supabase, isTaskScheduledForToday } from "@/lib/supabase";
import { sendTelegramMessage, InlineKeyboard } from "@/lib/telegram";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    // Current time in HH:MM:00 (or query parameter if testing)
    const url = new URL(req.url);
    const simulatedTime = url.searchParams.get("time");
    const targetChatId = url.searchParams.get("chat_id") || process.env.TELEGRAM_DEFAULT_CHAT_ID;

    if (!targetChatId) {
      return NextResponse.json({ error: "Missing chat_id parameter or TELEGRAM_DEFAULT_CHAT_ID env var" }, { status: 400 });
    }

    let timeToMatch = simulatedTime;
    if (!timeToMatch) {
      const now = new Date();
      const hours = String(now.getHours()).padStart(2, "0");
      const minutes = String(now.getMinutes()).padStart(2, "0");
      timeToMatch = `${hours}:${minutes}:00`;
    }

    // Find all active tasks scheduled for this exact time
    const { data: dueTasks, error } = await supabase
      .from("tasks")
      .select("*")
      .eq("is_archived", false)
      .eq("reminder_time", timeToMatch);

    if (error) {
      console.error("Error querying reminders:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!dueTasks || dueTasks.length === 0) {
      return NextResponse.json({ status: "no_reminders_due", checked_time: timeToMatch });
    }

    // Dispatch reminders to Telegram
    for (const task of dueTasks) {
      if (!isTaskScheduledForToday(task.target_days)) {
        continue;
      }
      let text = `⏰ <b>Reminder: ${task.name}!</b>\n`;
      let keyboard: InlineKeyboard = [];

      if (task.type === "timer") {
        text += `Scheduled study/work session (Target: ${task.target_value || 60} mins).\nReady to start?`;
        keyboard = [
          [
            { text: `▶️ Start ${task.name}`, callback_data: `start_task:${task.id}` },
            { text: "⏱️ Snooze 15m", callback_data: "snooze:15" },
          ],
        ];
      } else if (task.type === "tick") {
        text += `Scheduled routine (e.g. Wake Up).\nTap below when done:`;
        keyboard = [
          [{ text: `✅ Done with ${task.name}`, callback_data: `tick_task:${task.id}` }],
        ];
      } else if (task.type === "counter") {
        text += `Goal check-in (Target: ${task.target_value} ${task.unit || "units"}).`;
        keyboard = [
          [{ text: `💧 +500ml`, callback_data: `water_add:500` }],
        ];
      }

      await sendTelegramMessage(targetChatId, text, keyboard);
    }

    return NextResponse.json({
      status: "reminders_sent",
      count: dueTasks.length,
      tasks: dueTasks.map((t) => t.name),
    });
  } catch (err: any) {
    console.error("Reminder route error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

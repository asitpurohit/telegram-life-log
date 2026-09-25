import { NextRequest, NextResponse } from "next/server";
import { sendDueReminders } from "@/lib/reminders";
import { isCronAuthorized } from "@/lib/cronAuth";

export const dynamic = "force-dynamic";

// Can be triggered by a cron job (Vercel cron / external scheduler) or by the
// local polling runner, which calls sendDueReminders() directly every minute.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(req.url);
    const simulatedTime = url.searchParams.get("time");
    const targetChatId = url.searchParams.get("chat_id");

    const result = await sendDueReminders(simulatedTime || undefined, targetChatId);
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("Reminder route error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

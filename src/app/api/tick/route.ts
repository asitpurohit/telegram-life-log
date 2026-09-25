import { NextRequest, NextResponse } from "next/server";
import { refreshRunningTimerMessages } from "@/lib/timerRuntime";
import { sendDueReminders } from "@/lib/reminders";
import { recordCronHeartbeat } from "@/lib/supabase";
import { isCronAuthorized } from "@/lib/cronAuth";

export const dynamic = "force-dynamic";

// ONE cron URL that does both jobs every minute:
//  - refreshes running stopwatch messages (1-minute ticking on Vercel)
//  - sends any reminders that are due right now
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    await recordCronHeartbeat("tick");
    await refreshRunningTimerMessages();
    const reminders = await sendDueReminders();
    return NextResponse.json({ status: "ok", reminders });
  } catch (err: any) {
    console.error("Cron tick error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

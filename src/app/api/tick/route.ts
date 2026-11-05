import { NextRequest, NextResponse } from "next/server";
import { refreshRunningTimerMessages } from "@/lib/timerRuntime";
import { checkAndSendIdleNudges } from "@/lib/idleGuardian";
import { sendDueReminders } from "@/lib/reminders";
import { recordCronHeartbeat, ensureSystemTasks } from "@/lib/supabase";
import { isCronAuthorized } from "@/lib/cronAuth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ONE cron URL that does both jobs every minute:
//  - refreshes running stopwatch messages (1-minute ticking on Vercel)
//  - checks and sends idle anti-slacking alerts
//  - sends any reminders that are due right now
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    await recordCronHeartbeat("tick");
    await ensureSystemTasks();
    await refreshRunningTimerMessages();
    await checkAndSendIdleNudges();
    const reminders = await sendDueReminders();
    return NextResponse.json({ status: "ok", reminders });
  } catch (err: any) {
    console.error("Cron tick error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

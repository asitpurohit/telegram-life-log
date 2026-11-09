import { NextRequest, NextResponse } from "next/server";
import {
  getActiveTimer,
  getPauseState,
  getTimerProjectProgress,
  getActiveTimerAutoAdvance,
} from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const chatId = searchParams.get("chatId");

    if (!chatId) {
      return NextResponse.json({ ok: false, error: "Missing chatId" }, { status: 400 });
    }

    const [active, pause] = await Promise.all([
      getActiveTimer(chatId),
      getPauseState(chatId),
    ]);

    if (!active) {
      return NextResponse.json({ ok: true, active: null });
    }

    const [progressStr, autoAdvance] = await Promise.all([
      active.project_id ? getTimerProjectProgress(active.project_id) : Promise.resolve(null),
      active.is_pomodoro ? getActiveTimerAutoAdvance(chatId, active) : Promise.resolve(false),
    ]);

    const isPaused = Boolean(pause.pausedAt && pause.pausedAt > 0);

    return NextResponse.json({
      ok: true,
      active: {
        taskName: active.task_name,
        projectName: active.project_name || null,
        projectProgress: progressStr,
        todoTitle: active.todo_title || null,
        startedAt: active.started_at,
        isPomodoro: Boolean(active.is_pomodoro),
        autoAdvance: Boolean(autoAdvance),
        workMins: active.pomodoro_work_mins || 25,
        breakMins: active.pomodoro_break_mins || 5,
        round: active.pomodoro_round || 1,
        phase: active.pomodoro_phase || "work",
        phaseStartedAt: active.phase_started_at || active.started_at,
        isPaused,
        pausedSeconds: pause.pausedSeconds || 0,
        pausedAt: pause.pausedAt || null,
      },
    });
  } catch (err: any) {
    console.error("Error in /api/timer/active:", err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

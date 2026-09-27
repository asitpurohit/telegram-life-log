import { createClient } from "@supabase/supabase-js";
import { Task, Log, ActiveTimer, WizardSession, Todo } from "./types";
import { localDateString, localTimeString, localWeekday } from "./time";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder-project.supabase.co";
const supabaseKey = 
  process.env.SUPABASE_SERVICE_ROLE_KEY || 
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || 
  process.env.SUPABASE_ANON_KEY || 
  "placeholder-anon-key";

export const supabase = createClient(supabaseUrl, supabaseKey);

// ==========================================
// TASK OPERATIONS
// ==========================================

export async function getActiveTasks(): Promise<Task[]> {
  // Ordered by reminder time (morning -> evening); tasks without a reminder go last
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("is_archived", false)
    .order("reminder_time", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Error fetching tasks:", error);
    return [];
  }
  return data || [];
}

export async function getTaskById(taskId: string): Promise<Task | null> {
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", taskId)
    .single();

  if (error) return null;
  return data;
}

function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function findTaskByName(name: string): Promise<Task | null> {
  const escaped = escapeLikePattern(name);

  // Prefer an exact (case-insensitive) match before falling back to fuzzy search,
  // so "phy" resolves to "Phy" instead of "Physics".
  const { data: exactMatch, error: exactError } = await supabase
    .from("tasks")
    .select("*")
    .ilike("name", escaped)
    .eq("is_archived", false)
    .limit(1)
    .maybeSingle();

  if (!exactError && exactMatch) return exactMatch;

  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .ilike("name", `%${escaped}%`)
    .eq("is_archived", false)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) return null;
  return data;
}

// Case-insensitive EXACT name check for duplicate detection.
// Archived rows are included because the DB UNIQUE(name) constraint counts them.
export async function taskNameExists(name: string): Promise<Task | null> {
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .ilike("name", escapeLikePattern(name))
    .limit(1)
    .maybeSingle();

  if (error) return null;
  return data;
}

export async function createTask(task: Partial<Task>): Promise<Task | null> {
  // If an archived task with the same name exists, revive it so past logs stay linked.
  if (task.name) {
    const { data: archivedMatch } = await supabase
      .from("tasks")
      .select("id")
      .ilike("name", escapeLikePattern(task.name))
      .eq("is_archived", true)
      .limit(1)
      .maybeSingle();

    if (archivedMatch) {
      const { data, error } = await supabase
        .from("tasks")
        .update({
          type: task.type,
          reminder_time: task.reminder_time ?? null,
          target_value: task.target_value ?? null,
          unit: task.unit ?? null,
          target_days: task.target_days ?? "daily",
          is_archived: false,
        })
        .eq("id", archivedMatch.id)
        .select()
        .maybeSingle();

      if (error) {
        console.error("Error reviving task:", error);
        return null;
      }
      return data;
    }
  }

  const { data, error } = await supabase
    .from("tasks")
    .insert([task])
    .select()
    .single();

  if (error) {
    console.error("Error creating task:", error);
    return null;
  }
  return data;
}

export async function updateTask(taskId: string, updates: Partial<Task>): Promise<Task | null> {
  const { data, error } = await supabase
    .from("tasks")
    .update(updates)
    .eq("id", taskId)
    .select()
    .maybeSingle();

  if (error) {
    console.error("Error updating task:", error);
    return null;
  }
  return data;
}

export function getTaskSchedule(task: Task): string {
  return task.target_days || "daily";
}

export function formatScheduleDisplay(schedule?: string | null): string {
  if (!schedule || schedule === "daily") return "Daily (Every Day)";
  if (schedule === "weekdays") return "Weekdays (Mon - Fri)";
  if (schedule === "weekends") return "Weekends (Sat - Sun)";
  return schedule;
}

export function isTaskScheduledForToday(targetDays?: string | null): boolean {
  if (!targetDays || targetDays === "daily" || targetDays.toLowerCase() === "every day") {
    return true;
  }
  const { short: dayNameShort, long: dayNameLong } = localWeekday();
  const dayOfWeekShort = dayNameShort.toLowerCase();

  if (targetDays === "weekdays") return ["mon", "tue", "wed", "thu", "fri"].includes(dayOfWeekShort);
  if (targetDays === "weekends") return ["sat", "sun"].includes(dayOfWeekShort);

  const days = targetDays.split(",").map((d) => d.trim().toLowerCase());
  return (
    days.includes(dayNameShort.toLowerCase()) ||
    days.includes(dayNameLong.toLowerCase())
  );
}


export async function archiveTask(taskId: string): Promise<boolean> {
  const { error } = await supabase
    .from("tasks")
    .update({ is_archived: true })
    .eq("id", taskId);

  return !error;
}

// ==========================================
// TIMER OPERATIONS
// ==========================================

export async function startActiveTimer(
  chatId: string | number,
  taskId: string,
  taskName: string
): Promise<ActiveTimer | null> {
  const startedAt = new Date().toISOString();

  // Upsert active timer for this chat
  const { data, error } = await supabase
    .from("active_timers")
    .upsert({
      chat_id: String(chatId),
      task_id: taskId,
      task_name: taskName,
      started_at: startedAt,
    })
    .select()
    .single();

  if (error) {
    console.error("Error starting timer:", error);
    return null;
  }
  return data;
}

export async function getActiveTimer(chatId: string | number): Promise<ActiveTimer | null> {
  const { data, error } = await supabase
    .from("active_timers")
    .select("*")
    .eq("chat_id", String(chatId))
    .maybeSingle();

  if (error) return null;
  return data;
}

export async function getAllActiveTimers(): Promise<ActiveTimer[]> {
  const { data, error } = await supabase.from("active_timers").select("*");
  if (error) return [];
  return data || [];
}

// Pause state lives in the DB (KV row) so it survives restarts and works
// across serverless instances. started_at is NEVER modified.
const PAUSE_PREFIX = "__pause__:";

export interface PauseState {
  pausedAt: number | null; // epoch ms when the current pause began (null = running)
  pausedSeconds: number; // accumulated paused seconds from earlier pauses
}

export async function getPauseState(chatId: string | number): Promise<PauseState> {
  const { data, error } = await supabase
    .from("wizard_sessions")
    .select("task_data")
    .eq("chat_id", `${PAUSE_PREFIX}${chatId}`)
    .maybeSingle();

  if (error || !data) return { pausedAt: null, pausedSeconds: 0 };

  const state = data.task_data as { pausedAt?: unknown; pausedSeconds?: unknown } | null;
  const pausedAt = typeof state?.pausedAt === "number" ? state.pausedAt : null;
  const pausedSeconds = typeof state?.pausedSeconds === "number" ? state.pausedSeconds : 0;
  return { pausedAt, pausedSeconds };
}

export async function setPauseState(chatId: string | number, state: PauseState): Promise<void> {
  const { error } = await supabase
    .from("wizard_sessions")
    .upsert({
      chat_id: `${PAUSE_PREFIX}${chatId}`,
      step: "ui_pause",
      task_data: { pausedAt: state.pausedAt, pausedSeconds: state.pausedSeconds },
      updated_at: new Date().toISOString(),
    });

  if (error) console.error("Error saving pause state:", error);
}

export async function clearPauseState(chatId: string | number): Promise<void> {
  const { error } = await supabase
    .from("wizard_sessions")
    .delete()
    .eq("chat_id", `${PAUSE_PREFIX}${chatId}`);

  if (error) console.error("Error clearing pause state:", error);
}

// Running-timer nudge state (the "still running" notification message)
const NUDGE_PREFIX = "__nudge__:";

export interface NudgeState {
  messageId: number | null; // the currently visible nudge message
  nextNudgeAt: number; // epoch ms when the next nudge is due (0 = never set)
}

export async function getNudgeState(chatId: string | number): Promise<NudgeState> {
  const { data, error } = await supabase
    .from("wizard_sessions")
    .select("task_data")
    .eq("chat_id", `${NUDGE_PREFIX}${chatId}`)
    .maybeSingle();

  if (error || !data) return { messageId: null, nextNudgeAt: 0 };

  const state = data.task_data as { messageId?: unknown; nextNudgeAt?: unknown } | null;
  const messageId = typeof state?.messageId === "number" ? state.messageId : null;
  const nextNudgeAt = typeof state?.nextNudgeAt === "number" ? state.nextNudgeAt : 0;
  return { messageId, nextNudgeAt };
}

export async function setNudgeState(chatId: string | number, state: NudgeState): Promise<void> {
  const { error } = await supabase
    .from("wizard_sessions")
    .upsert({
      chat_id: `${NUDGE_PREFIX}${chatId}`,
      step: "ui_nudge",
      task_data: { messageId: state.messageId, nextNudgeAt: state.nextNudgeAt },
      updated_at: new Date().toISOString(),
    });

  if (error) console.error("Error saving nudge state:", error);
}

export async function clearNudgeState(chatId: string | number): Promise<void> {
  const { error } = await supabase
    .from("wizard_sessions")
    .delete()
    .eq("chat_id", `${NUDGE_PREFIX}${chatId}`);

  if (error) console.error("Error clearing nudge state:", error);
}

export async function stopActiveTimer(
  chatId: string | number,
  endTimeMs?: number,
  pausedSeconds = 0
): Promise<{
  taskName: string;
  durationSeconds: number;
  durationMinutes: number;
  taskId: string;
  logId: string | null;
} | null> {
  const active = await getActiveTimer(chatId);
  if (!active) return null;

  const startedAt = new Date(active.started_at);
  const endedAt = new Date(endTimeMs ?? Date.now());
  const workedSeconds = Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000) - pausedSeconds;
  const durationSeconds = Math.max(1, workedSeconds);
  const durationMinutes = Math.max(1, Math.round(durationSeconds / 60));

  // Log completed session to logs table (the ONLY database write for a timer)
  const sessionLog = await logActivity({
    task_id: active.task_id,
    task_name: active.task_name,
    value: durationMinutes,
    notes: `Timer session from ${localTimeString(startedAt, true)} to ${localTimeString(endedAt, true)}`,
  });

  // Remove from active timers
  await supabase.from("active_timers").delete().eq("chat_id", String(chatId));

  return {
    taskName: active.task_name,
    durationSeconds,
    durationMinutes,
    taskId: active.task_id,
    logId: sessionLog?.id || null,
  };
}

// ==========================================
// LOG OPERATIONS (History, Habits, Diary)
// ==========================================

export async function logActivity(log: Log): Promise<Log | null> {
  const insertPayload: any = {
    task_id: log.task_id || null,
    task_name: log.task_name,
    log_date: log.log_date || localDateString(),
    value: log.value ?? 1,
    notes: log.notes || null,
  };

  if (log.summary !== undefined) insertPayload.summary = log.summary;
  if (log.projects !== undefined) insertPayload.projects = log.projects;
  if (log.people !== undefined) insertPayload.people = log.people;
  if (log.decisions !== undefined) insertPayload.decisions = log.decisions;
  if (log.mood !== undefined) insertPayload.mood = log.mood;
  if (log.focus !== undefined) insertPayload.focus = log.focus;

  const { data, error } = await supabase
    .from("logs")
    .insert([insertPayload])
    .select()
    .single();

  if (error) {
    console.error("Error logging activity:", error);
    return null;
  }
  return data;
}

export async function updateDiaryMood(logId: string, mood: string): Promise<boolean> {
  const { error } = await supabase
    .from("logs")
    .update({ mood })
    .eq("id", logId);

  if (error) {
    console.error("Error updating diary mood:", error);
    return false;
  }
  return true;
}

// ==========================================
// SESSION FOCUS (per task entry: focused / casual / distracted)
// ==========================================

export interface FocusTotals {
  focused: number;
  casual: number;
  distracted: number;
  tagged: number;
}

export async function updateLogFocus(logId: string, focus: string): Promise<boolean> {
  const { error } = await supabase
    .from("logs")
    .update({ focus })
    .eq("id", logId);

  if (error) {
    console.error("Error updating log focus:", error);
    return false;
  }
  return true;
}

// Focus totals for one task today (only positive tagged entries are counted)
export async function getTodayTaskFocus(taskName: string): Promise<FocusTotals> {
  const today = localDateString();
  const { data, error } = await supabase
    .from("logs")
    .select("focus, value")
    .eq("task_name", taskName)
    .eq("log_date", today)
    .not("focus", "is", null);

  if (error || !data) return { focused: 0, casual: 0, distracted: 0, tagged: 0 };
  return sumFocusRows(data);
}

// Focus totals per task over a date range (used by /ask)
export async function getFocusTotals(
  from: string,
  to: string,
  taskName?: string
): Promise<Array<{ task: string } & FocusTotals>> {
  let query = supabase
    .from("logs")
    .select("task_name, focus, value")
    .gte("log_date", from)
    .lte("log_date", to)
    .not("focus", "is", null)
    .limit(2000);

  if (taskName) query = query.ilike("task_name", `%${taskName}%`);

  const { data, error } = await query;
  if (error || !data) return [];

  const byTask = new Map<string, FocusTotals>();
  for (const row of data) {
    const value = row.value || 0;
    if (value <= 0 || !row.focus) continue;
    if (!["focused", "casual", "distracted"].includes(row.focus)) continue;

    const entry = byTask.get(row.task_name) || { focused: 0, casual: 0, distracted: 0, tagged: 0 };
    if (row.focus === "focused") entry.focused += value;
    else if (row.focus === "casual") entry.casual += value;
    else entry.distracted += value;
    entry.tagged += value;
    byTask.set(row.task_name, entry);
  }

  return Array.from(byTask.entries()).map(([task, totals]) => ({ task, ...totals }));
}

function sumFocusRows(rows: Array<{ focus: string | null; value: number | null }>): FocusTotals {
  const totals: FocusTotals = { focused: 0, casual: 0, distracted: 0, tagged: 0 };
  for (const row of rows) {
    const value = row.value || 0;
    if (value <= 0 || !row.focus) continue;
    if (!["focused", "casual", "distracted"].includes(row.focus)) continue;

    if (row.focus === "focused") totals.focused += value;
    else if (row.focus === "casual") totals.casual += value;
    else totals.distracted += value;
    totals.tagged += value;
  }
  return totals;
}

export function formatMoodDisplay(mood?: string | null): string {
  if (!mood) return "";
  const m = mood.toLowerCase();
  if (m.includes("happy") || m.includes("great") || m.includes("joy")) return "😊 Happy";
  if (m.includes("productive") || m.includes("energetic") || m.includes("focus")) return "⚡ Productive";
  if (m.includes("okay") || m.includes("neutral") || m.includes("fine")) return "😐 Okay";
  if (m.includes("bad") || m.includes("sad") || m.includes("down")) return "😔 Bad";
  if (m.includes("tired") || m.includes("exhaust")) return "😴 Tired";
  if (m.includes("stress") || m.includes("anxious")) return "😰 Stressed";
  if (m.includes("grateful") || m.includes("peace")) return "🙏 Grateful";
  return `✨ ${mood.charAt(0).toUpperCase() + mood.slice(1)}`;
}

export async function getTodayTaskTotal(taskName: string): Promise<number> {
  const today = localDateString();
  const { data, error } = await supabase
    .from("logs")
    .select("value")
    .eq("task_name", taskName)
    .eq("log_date", today);

  if (error || !data) return 0;
  return data.reduce((sum, row) => sum + (row.value || 0), 0);
}

export async function getTodayLogs(): Promise<Log[]> {
  const today = localDateString();
  const { data, error } = await supabase
    .from("logs")
    .select("*")
    .eq("log_date", today)
    .order("created_at", { ascending: true });

  if (error) return [];
  return data || [];
}

export async function getLogsInRange(from: string, to: string): Promise<Log[]> {
  const { data, error } = await supabase
    .from("logs")
    .select("*")
    .gte("log_date", from)
    .lte("log_date", to)
    .order("created_at", { ascending: true });

  if (error) return [];
  return data || [];
}

export async function isTaskCompletedToday(taskId: string): Promise<boolean> {
  const today = localDateString();
  const { data, error } = await supabase
    .from("logs")
    .select("id, value")
    .eq("task_id", taskId)
    .eq("log_date", today)
    .gt("value", 0)
    .limit(1);

  if (error || !data) return false;
  return data.length > 0;
}

export async function getTodayLogForTask(taskId: string): Promise<Log | null> {
  const today = localDateString();
  const { data, error } = await supabase
    .from("logs")
    .select("*")
    .eq("task_id", taskId)
    .eq("log_date", today)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

export async function untickTaskToday(taskId: string): Promise<boolean> {
  const today = localDateString();
  const { error } = await supabase
    .from("logs")
    .delete()
    .eq("task_id", taskId)
    .eq("log_date", today);

  return !error;
}

export async function deduplicateTodayTickLogs(taskId: string): Promise<void> {
  const today = localDateString();
  const { data } = await supabase
    .from("logs")
    .select("id, created_at")
    .eq("task_id", taskId)
    .eq("log_date", today)
    .order("created_at", { ascending: true });

  if (data && data.length > 1) {
    const idsToDelete = data.slice(1).map((d) => d.id);
    await supabase.from("logs").delete().in("id", idsToDelete);
  }
}


// ==========================================
// WIZARD SESSIONS (Guided /addtask Flow)
// ==========================================

export async function getWizardSession(chatId: string | number): Promise<WizardSession | null> {
  const cId = String(chatId);
  try {
    const { data, error } = await supabase
      .from("wizard_sessions")
      .select("*")
      .eq("chat_id", cId)
      .maybeSingle();

    if (!error && data) {
      return data as WizardSession;
    }
  } catch (err) {
    console.error("Error fetching wizard session:", err);
  }
  return null;
}

export async function saveWizardSession(
  chatId: string | number,
  step: WizardSession["step"],
  taskData: WizardSession["task_data"]
): Promise<boolean> {
  const cId = String(chatId);
  try {
    const { error } = await supabase
      .from("wizard_sessions")
      .upsert({
        chat_id: cId,
        step,
        task_data: taskData,
        updated_at: new Date().toISOString(),
      });

    if (error) {
      console.error("Error saving wizard session:", error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Error saving wizard session:", err);
    return false;
  }
}

// ==========================================
// TODO OPERATIONS (one-time, date + time)
// ==========================================

export async function createTodo(title: string, dueAtIso: string): Promise<Todo | null> {
  const { data, error } = await supabase
    .from("todos")
    .insert([{ title, due_at: dueAtIso }])
    .select()
    .single();

  if (error) {
    console.error("Error creating todo:", error);
    return null;
  }
  return data;
}

export async function getTodos(): Promise<Todo[]> {
  const { data, error } = await supabase
    .from("todos")
    .select("*")
    .order("is_done", { ascending: true })
    .order("due_at", { ascending: true });

  if (error) {
    console.error("Error fetching todos:", error);
    return [];
  }
  return data || [];
}

export async function getTodoById(id: string): Promise<Todo | null> {
  const { data, error } = await supabase.from("todos").select("*").eq("id", id).maybeSingle();
  if (error) return null;
  return data;
}

export async function setTodoDone(id: string, done: boolean): Promise<Todo | null> {
  const { data, error } = await supabase
    .from("todos")
    .update({ is_done: done, done_at: done ? new Date().toISOString() : null })
    .eq("id", id)
    .select()
    .maybeSingle();

  if (error) {
    console.error("Error updating todo:", error);
    return null;
  }
  return data;
}

export async function deleteTodo(id: string): Promise<boolean> {
  const { error } = await supabase.from("todos").delete().eq("id", id);
  return !error;
}

// Pending todos whose time has arrived (with an optional catch-up window)
export async function getDueTodos(catchUpHours = 6): Promise<Todo[]> {
  const now = Date.now();
  const { data, error } = await supabase
    .from("todos")
    .select("*")
    .eq("is_done", false)
    .is("reminded_at", null)
    .lte("due_at", new Date(now).toISOString())
    .gte("due_at", new Date(now - catchUpHours * 3600000).toISOString());

  if (error) {
    console.error("Error fetching due todos:", error);
    return [];
  }
  return data || [];
}

// Marks a todo as reminded; returns false if someone else already claimed it
export async function claimTodoReminder(id: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("todos")
    .update({ reminded_at: new Date().toISOString() })
    .eq("id", id)
    .is("reminded_at", null)
    .select("id");

  if (error) {
    console.error("Error claiming todo reminder:", error);
    return true;
  }
  return (data?.length || 0) > 0;
}

// ==========================================
// UI MESSAGE TRACKING (retire old keyboards)
// Stored in wizard_sessions under a prefixed chat_id so it never collides
// with the real conversation state of the same chat.
// ==========================================

const UI_TRACK_PREFIX = "__ui__:";
const TIMER_MSG_PREFIX = "__timer__:";

async function setTrackedMessage(
  prefix: string,
  chatId: string | number,
  messageId: number
): Promise<void> {
  const { error } = await supabase
    .from("wizard_sessions")
    .upsert({
      chat_id: `${prefix}${chatId}`,
      step: "ui_menu",
      task_data: { promptMessageId: messageId },
      updated_at: new Date().toISOString(),
    });

  if (error) console.error("Error tracking message:", error);
}

async function getTrackedMessage(prefix: string, chatId: string | number): Promise<number | null> {
  const { data, error } = await supabase
    .from("wizard_sessions")
    .select("task_data")
    .eq("chat_id", `${prefix}${chatId}`)
    .maybeSingle();

  if (error || !data) return null;
  const messageId = (data.task_data as { promptMessageId?: unknown } | null)?.promptMessageId;
  return typeof messageId === "number" ? messageId : null;
}

export async function trackUiMessage(chatId: string | number, messageId: number): Promise<void> {
  return setTrackedMessage(UI_TRACK_PREFIX, chatId, messageId);
}

export async function getTrackedUiMessage(chatId: string | number): Promise<number | null> {
  return getTrackedMessage(UI_TRACK_PREFIX, chatId);
}

export async function trackTimerMessage(chatId: string | number, messageId: number): Promise<void> {
  return setTrackedMessage(TIMER_MSG_PREFIX, chatId, messageId);
}

export async function getTimerMessage(chatId: string | number): Promise<number | null> {
  return getTrackedMessage(TIMER_MSG_PREFIX, chatId);
}

// Heartbeat so we can verify the external cron is actually reaching the app
export async function recordCronHeartbeat(source: string): Promise<void> {
  const { error } = await supabase
    .from("wizard_sessions")
    .upsert({
      chat_id: `__cron__:${source}`,
      step: "ui_cron",
      task_data: { at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    });

  if (error) console.error("Error recording cron heartbeat:", error);
}

const ACTIVE_TASK_PREFIX = "__task__:";

export async function setActiveTask(chatId: string | number, taskId: string | null): Promise<void> {
  const chatKey = `${ACTIVE_TASK_PREFIX}${chatId}`;

  if (!taskId) {
    await supabase.from("wizard_sessions").delete().eq("chat_id", chatKey);
    return;
  }

  const { error } = await supabase
    .from("wizard_sessions")
    .upsert({
      chat_id: chatKey,
      step: "ui_task",
      task_data: { taskId },
      updated_at: new Date().toISOString(),
    });

  if (error) console.error("Error setting active task:", error);
}

export async function getActiveTaskId(chatId: string | number): Promise<string | null> {
  const { data, error } = await supabase
    .from("wizard_sessions")
    .select("task_data")
    .eq("chat_id", `${ACTIVE_TASK_PREFIX}${chatId}`)
    .maybeSingle();

  if (error || !data) return null;
  const taskId = (data.task_data as { taskId?: unknown } | null)?.taskId;
  return typeof taskId === "string" ? taskId : null;
}

export async function clearWizardSession(chatId: string | number): Promise<boolean> {
  const cId = String(chatId);
  try {
    const { error } = await supabase
      .from("wizard_sessions")
      .delete()
      .eq("chat_id", cId);

    if (error) {
      console.error("Error clearing wizard session:", error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Error clearing wizard session:", err);
    return false;
  }
}


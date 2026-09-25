import { createClient } from "@supabase/supabase-js";
import { Task, Log, ActiveTimer, WizardSession } from "./types";

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
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("is_archived", false)
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

export async function findTaskByName(name: string): Promise<Task | null> {
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .ilike("name", `%${name}%`)
    .eq("is_archived", false)
    .limit(1)
    .maybeSingle();

  if (error) return null;
  return data;
}

export async function createTask(task: Partial<Task>): Promise<Task | null> {
  const { data, error } = await supabase
    .from("tasks")
    .insert([task])
    .select()
    .single();

  if (!error) return data;

  // Fallback if target_days column is not yet in database table
  if (error && (error.code === "PGRST204" || error.code === "42703")) {
    const { target_days, ...rest } = task;
    const fallbackUnit = target_days ? `${rest.unit || ""}|${target_days}` : rest.unit;
    const { data: fbData, error: fbError } = await supabase
      .from("tasks")
      .insert([{ ...rest, unit: fallbackUnit }])
      .select()
      .single();

    if (fbError) {
      console.error("Error creating task with fallback:", fbError);
      return null;
    }
    return fbData;
  }

  console.error("Error creating task:", error);
  return null;
}

export function getTaskSchedule(task: Task): string {
  if (task.target_days) return task.target_days;
  if (task.unit && task.unit.includes("|")) {
    return task.unit.split("|")[1];
  }
  return "daily";
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

export async function stopActiveTimer(chatId: string | number): Promise<{
  taskName: string;
  durationMinutes: number;
  taskId: string;
} | null> {
  const active = await getActiveTimer(chatId);
  if (!active) return null;

  const startedAt = new Date(active.started_at);
  const endedAt = new Date();
  const durationMinutes = Math.max(1, Math.round((endedAt.getTime() - startedAt.getTime()) / 60000));

  // Log completed session to logs table
  await logActivity({
    task_id: active.task_id,
    task_name: active.task_name,
    value: durationMinutes,
    notes: `Timer session from ${startedAt.toLocaleTimeString()} to ${endedAt.toLocaleTimeString()}`,
  });

  // Remove from active timers
  await supabase.from("active_timers").delete().eq("chat_id", String(chatId));

  return {
    taskName: active.task_name,
    durationMinutes,
    taskId: active.task_id,
  };
}

// ==========================================
// LOG OPERATIONS (History, Habits, Diary)
// ==========================================

export async function logActivity(log: Log): Promise<Log | null> {
  const { data, error } = await supabase
    .from("logs")
    .insert([
      {
        task_id: log.task_id || null,
        task_name: log.task_name,
        log_date: log.log_date || new Date().toISOString().split("T")[0],
        value: log.value ?? 1,
        notes: log.notes || null,
      },
    ])
    .select()
    .single();

  if (error) {
    console.error("Error logging activity:", error);
    return null;
  }
  return data;
}

export async function getTodayTaskTotal(taskName: string): Promise<number> {
  const today = new Date().toISOString().split("T")[0];
  const { data, error } = await supabase
    .from("logs")
    .select("value")
    .eq("task_name", taskName)
    .eq("log_date", today);

  if (error || !data) return 0;
  return data.reduce((sum, row) => sum + (row.value || 0), 0);
}

export async function getTodayLogs(): Promise<Log[]> {
  const today = new Date().toISOString().split("T")[0];
  const { data, error } = await supabase
    .from("logs")
    .select("*")
    .eq("log_date", today)
    .order("created_at", { ascending: true });

  if (error) return [];
  return data || [];
}

export async function isTaskCompletedToday(taskId: string): Promise<boolean> {
  const today = new Date().toISOString().split("T")[0];
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
  const today = new Date().toISOString().split("T")[0];
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
  const today = new Date().toISOString().split("T")[0];
  const { error } = await supabase
    .from("logs")
    .delete()
    .eq("task_id", taskId)
    .eq("log_date", today);

  return !error;
}

export async function deduplicateTodayTickLogs(taskId: string): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
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
    // 1. Try dedicated wizard_sessions table
    const { data, error } = await supabase
      .from("wizard_sessions")
      .select("*")
      .eq("chat_id", cId)
      .maybeSingle();

    if (!error && data) {
      return data as WizardSession;
    }

    // 2. Fallback to logs table if wizard_sessions table does not exist
    if (error && error.code === "PGRST205") {
      const { data: logData } = await supabase
        .from("logs")
        .select("*")
        .eq("task_name", "__wizard_session__")
        .ilike("notes", `%"chat_id":"${cId}"%`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (logData && logData.notes) {
        try {
          const parsed = JSON.parse(logData.notes);
          return {
            chat_id: parsed.chat_id,
            step: parsed.step,
            task_data: parsed.task_data,
          };
        } catch {
          return null;
        }
      }
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
    // 1. Try dedicated wizard_sessions table
    const { error } = await supabase
      .from("wizard_sessions")
      .upsert({
        chat_id: cId,
        step,
        task_data: taskData,
        updated_at: new Date().toISOString(),
      });

    if (!error) return true;

    // 2. Fallback to logs table
    if (error && error.code === "PGRST205") {
      await supabase
        .from("logs")
        .delete()
        .eq("task_name", "__wizard_session__")
        .ilike("notes", `%"chat_id":"${cId}"%`);

      const { error: insertErr } = await supabase.from("logs").insert([
        {
          task_name: "__wizard_session__",
          value: 0,
          notes: JSON.stringify({
            chat_id: cId,
            step,
            task_data: taskData,
          }),
        },
      ]);

      return !insertErr;
    }
  } catch (err) {
    console.error("Error saving wizard session:", err);
  }

  return false;
}

export async function clearWizardSession(chatId: string | number): Promise<boolean> {
  const cId = String(chatId);
  try {
    // Delete from wizard_sessions if exists
    await supabase.from("wizard_sessions").delete().eq("chat_id", cId);
  } catch {
    // Ignore error if table doesn't exist
  }

  try {
    // Delete fallback from logs
    await supabase
      .from("logs")
      .delete()
      .eq("task_name", "__wizard_session__")
      .ilike("notes", `%"chat_id":"${cId}"%`);
  } catch (err) {
    console.error("Error clearing wizard session:", err);
  }

  return true;
}


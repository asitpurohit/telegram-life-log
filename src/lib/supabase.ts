import { createClient } from "@supabase/supabase-js";
import { Task, Log, ActiveTimer } from "./types";

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

  if (error) {
    console.error("Error creating task:", error);
    return null;
  }
  return data;
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

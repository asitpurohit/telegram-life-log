import { supabase } from "../src/lib/supabase";

async function verifySupabase() {
  console.log("🔍 Checking Supabase tables and columns...\n");

  // 1. Check tasks table and target_days column
  const { data: taskData, error: taskError } = await supabase
    .from("tasks")
    .select("id, name, type, reminder_time, target_value, unit, target_days, is_archived, created_at")
    .limit(1);

  if (taskError) {
    console.error("❌ tasks table check failed:", taskError.message);
  } else {
    console.log("✅ tasks table OK! Native target_days column exists.");
  }

  // 2. Check logs table
  const { data: logsData, error: logsError } = await supabase
    .from("logs")
    .select("id, task_id, task_name, log_date, value, notes, created_at")
    .limit(1);

  if (logsError) {
    console.error("❌ logs table check failed:", logsError.message);
  } else {
    console.log("✅ logs table OK!");
  }

  // 3. Check active_timers table
  const { data: timerData, error: timerError } = await supabase
    .from("active_timers")
    .select("chat_id, task_id, task_name, started_at")
    .limit(1);

  if (timerError) {
    console.error("❌ active_timers table check failed:", timerError.message);
  } else {
    console.log("✅ active_timers table OK!");
  }

  // 4. Check wizard_sessions table
  const { data: wizData, error: wizError } = await supabase
    .from("wizard_sessions")
    .select("chat_id, step, task_data, updated_at")
    .limit(1);

  if (wizError) {
    console.error("❌ wizard_sessions table check failed:", wizError.message);
  } else {
    console.log("✅ wizard_sessions table OK!");
  }
}

verifySupabase();

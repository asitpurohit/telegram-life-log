export type TaskType = 'timer' | 'counter' | 'tick';

export interface Task {
  id: string;
  name: string;
  type: TaskType;
  reminder_time?: string | null; // e.g. "08:00:00"
  target_value?: number | null; // e.g. 60 (mins), 5000 (ml)
  unit?: string | null; // 'minutes', 'ml', 'status'
  target_days?: string | null; // 'daily', 'weekdays', 'weekends', or custom
  is_archived: boolean;
  created_at?: string;
}

export interface Log {
  id?: string;
  task_id?: string | null;
  task_name: string;
  log_date?: string; // YYYY-MM-DD
  value?: number;
  notes?: string | null;
  summary?: string | null;
  projects?: string[] | null;
  people?: string[] | null;
  decisions?: string[] | null;
  mood?: string | null;
  created_at?: string;
}

export interface Todo {
  id: string;
  title: string;
  due_at: string; // ISO timestamp (one-time)
  is_done: boolean;
  done_at?: string | null;
  reminded_at?: string | null;
  created_at?: string;
}

export interface ActiveTimer {
  chat_id: string;
  task_id: string;
  task_name: string;
  started_at: string;
}

export interface WizardSession {
  chat_id: string;
  step:
    | 'awaiting_name'
    | 'awaiting_timer_goal'
    | 'awaiting_counter_goal'
    | 'awaiting_reminder'
    | 'awaiting_days'
    | 'awaiting_diary_text'
    | 'awaiting_timer_custom'
    | 'awaiting_edit_name'
    | 'awaiting_edit_goal'
    | 'awaiting_edit_reminder'
    | 'awaiting_edit_days'
    | 'awaiting_todo_title'
    | 'awaiting_todo_date'
    | 'awaiting_todo_time';
  task_data: {
    type?: TaskType;
    name?: string;
    taskId?: string;
    target_days?: string;
    reminder_time?: string | null;
    target_value?: number | null;
    unit?: string | null;
    promptMessageId?: number;
    todoTitle?: string;
    todoDate?: string; // YYYY-MM-DD
  };
  updated_at?: string;
}





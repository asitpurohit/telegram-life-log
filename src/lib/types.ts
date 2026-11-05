export type TaskType = 'timer' | 'counter' | 'tick';

export interface Task {
  id: string;
  name: string;
  type: TaskType;
  reminder_time?: string | null; // e.g. "08:00:00"
  target_value?: number | null; // e.g. 60 (mins), 5000 (ml)
  unit?: string | null; // 'minutes', 'ml', 'status'
  target_days?: string | null; // 'daily', 'weekdays', 'weekends', or custom
  is_system?: boolean; // system-provisioned task (e.g. Sleep): name locked, cannot be deleted
  is_project_based?: boolean; // project-based timer tasks (tracks multi-session milestones)
  is_pomodoro?: boolean; // Pomodoro timer task with work/break intervals
  pomodoro_work_mins?: number | null; // e.g. 25
  pomodoro_break_mins?: number | null; // e.g. 5
  is_archived: boolean;
  created_at?: string;
}

export interface Project {
  id: string;
  task_id: string;
  name: string;
  status: 'in_progress' | 'completed';
  target_minutes?: number | null;
  description?: string | null;
  created_at?: string;
  completed_at?: string | null;
}

export interface ProjectTodo {
  id: string;
  task_id: string;
  project_id?: string | null;
  todo_date: string; // YYYY-MM-DD
  title: string;
  is_done: boolean;
  is_archived?: boolean;
  done_at?: string | null;
  created_at?: string;
}

export type FocusMood = "focused" | "casual" | "distracted";

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
  focus?: FocusMood | null;
  started_at?: string | null; // exact timer-session start (null for non-session logs)
  project_id?: string | null; // link to projects table
  todo_id?: string | null; // link to project_todos table
  todo_title?: string | null;
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
  project_id?: string | null;
  project_name?: string | null;
  todo_id?: string | null;
  todo_title?: string | null;
  started_at: string;
  is_pomodoro?: boolean;
  pomodoro_work_mins?: number | null;
  pomodoro_break_mins?: number | null;
  pomodoro_round?: number;
  pomodoro_phase?: 'work' | 'awaiting_break' | 'break';
  phase_started_at?: string;
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
    | 'awaiting_edit_pomodoro_work'
    | 'awaiting_edit_pomodoro_break'
    | 'awaiting_todo_title'
    | 'awaiting_todo_date'
    | 'awaiting_todo_time'
    | 'awaiting_doubt_topic'
    | 'awaiting_doubt_text'
    | 'awaiting_doubt_topic_confirm'
    | 'view_doubts'
    | 'awaiting_session_note'
    | 'awaiting_project_name'
    | 'awaiting_project_target'
    | 'awaiting_project_description'
    | 'awaiting_daily_todo_input'
    | 'awaiting_daily_todo_carryover'
    | 'awaiting_project_todos_resolution'
    | 'awaiting_session_todo_pick'
    | 'checkout_review'
    | 'timer_prestart'
    | 'awaiting_quick_project_name'
    | 'awaiting_quick_todo_title'
    | 'awaiting_settings_window'
    | 'awaiting_settings_interval'
    | 'awaiting_settings_email';
  task_data: {
    type?: TaskType;
    name?: string;
    taskId?: string;
    target_days?: string | null;
    reminder_time?: string | null;
    target_value?: number | null;
    unit?: string | null;
    promptMessageId?: number;
    userMessageId?: number;
    todoTitle?: string;
    todoDate?: string; // YYYY-MM-DD
    doubtTaskId?: string;
    doubtTaskName?: string;
    doubtTopic?: string;
    suggestedTopic?: string;
    doubtPage?: number;
    sessionLogId?: string;
    is_project_based?: boolean;
    is_pomodoro?: boolean;
    pomodoro_work_mins?: number | null;
    pomodoro_break_mins?: number | null;
    pomodoroWorkMins?: number;
    pomodoroBreakMins?: number;
    projectId?: string;
    projectName?: string;
    taskName?: string;
    projectTargetMinutes?: number | null;
    projectDescription?: string | null;
    todoId?: string;
    pastTodoIds?: string[];
    transferTodoIds?: string[];
    projectStatus?: 'completed' | 'in_progress';
    todoStatus?: 'completed' | 'in_progress';
    focus?: FocusMood;
    totalToday?: number;
    target?: number;
    percent?: number;
    durationSeconds?: number;
    splitStr?: string;
    freshDate?: string;
  };
  updated_at?: string;
}

export interface UserSettings {
  chat_id: string;
  idle_nudge_enabled: boolean;
  idle_window_start: string; // e.g. "05:00"
  idle_window_end: string;   // e.g. "22:00"
  idle_interval_mins: number; // e.g. 3, 5, 15
  idle_snoozed_until?: string | null;
  last_idle_nudge_at?: string | null;
  summary_email_to?: string | null;
  updated_at?: string;
}


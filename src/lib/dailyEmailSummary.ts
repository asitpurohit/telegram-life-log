import {
  getActiveTasks,
  getLogsInRange,
  getAllProjectTodosForDate,
  getTodos,
  taskEmoji,
  formatMoodDisplay,
} from "./supabase";
import { computeWastedDays, formatTimerMinutes, shiftDateString } from "./timeAudit";
import { localDateString, localTimeString } from "./time";
import { sendEmail, EmailSendResult } from "./emailSender";
import type { Task, Log, ProjectTodo, Todo } from "./types";

export interface DailySummaryData {
  date: string; // YYYY-MM-DD
  dateFormatted: string;
  totalFocusMin: number;
  sleepMin: number;
  wastedMin: number;
  tasksWorkedOn: Array<{
    task: Task;
    totalMin: number;
    pctOfTarget: number;
    targetMin: number;
    projects: Array<{
      name: string;
      minutes: number;
      notes: string[];
    }>;
    generalNotes: string[];
    focusCounts: { focused: number; casual: number; distracted: number };
  }>;
  completedTodos: Array<{
    title: string;
    taskName?: string;
    projectName?: string;
  }>;
  incompleteTodos: Array<{
    title: string;
    taskName?: string;
    projectName?: string;
  }>;
  habits: Array<{
    name: string;
    type: string;
    isDone: boolean;
    valDisplay: string;
  }>;
  diaryEntries: Array<{
    time: string;
    mood: string | null;
    content: string;
  }>;
}

/**
 * Gather all data for a specific date (defaults to yesterday)
 */
export async function getDailySummaryData(targetDate?: string): Promise<DailySummaryData> {
  const date = targetDate || shiftDateString(localDateString(), -1);

  // 1. All tasks and logs for target date
  const allTasks = await getActiveTasks();
  const logs = await getLogsInRange(date, date);

  // 2. Wasted time computation
  const [wastedStat] = computeWastedDays({
    dates: [date],
    logs,
    tasks: allTasks,
  });

  const sleepMin = wastedStat?.sleepMin || 0;
  const wastedMin = wastedStat?.wastedMin || 0;

  // 3. Daily Todos (completed vs incomplete)
  const dailyTodos = await getAllProjectTodosForDate(date);
  const taskMap = new Map<string, Task>();
  for (const t of allTasks) taskMap.set(t.id, t);

  // Map of logs to extract project names easily
  const projectNames = new Map<string, string>();
  for (const l of logs) {
    if (l.project_id && l.projects && l.projects[0]) {
      projectNames.set(l.project_id, l.projects[0]);
    }
  }

  const completedTodos: DailySummaryData["completedTodos"] = [];
  const incompleteTodos: DailySummaryData["incompleteTodos"] = [];

  for (const td of dailyTodos) {
    const task = taskMap.get(td.task_id);
    const pName = td.project_id ? projectNames.get(td.project_id) : undefined;
    const item = {
      title: td.title,
      taskName: task?.name,
      projectName: pName,
    };
    if (td.is_done) {
      completedTodos.push(item);
    } else {
      incompleteTodos.push(item);
    }
  }

  // Also check deadline-based todos due on this date
  try {
    const allDeadlineTodos = await getTodos();
    for (const td of allDeadlineTodos) {
      if (localDateString(new Date(td.due_at)) === date) {
        const item = {
          title: td.title,
          taskName: "Deadline To-Do",
        };
        if (td.is_done) {
          completedTodos.push(item);
        } else {
          incompleteTodos.push(item);
        }
      }
    }
  } catch {}

  // 4. Group timer tasks worked on
  const timerTasks = allTasks.filter((t) => t.type === "timer" && !t.is_system && !/sleep/i.test(t.name));
  const tasksWorkedOn: DailySummaryData["tasksWorkedOn"] = [];
  let totalFocusMin = 0;

  for (const t of timerTasks) {
    const taskLogs = logs.filter((l) => l.task_name === t.name);
    const taskTotalMin = taskLogs.reduce((acc, l) => acc + (l.value || 0), 0);

    if (taskTotalMin === 0 && taskLogs.length === 0) {
      continue; // Wasn't worked on yesterday
    }

    totalFocusMin += taskTotalMin;
    const targetMin = t.target_value || 60;
    const pctOfTarget = Math.round((taskTotalMin / targetMin) * 100);

    // Group by project
    const projectMap = new Map<string, { minutes: number; notes: string[] }>();
    const generalNotes: string[] = [];
    const focusCounts = { focused: 0, casual: 0, distracted: 0 };

    for (const l of taskLogs) {
      if (l.focus === "focused") focusCounts.focused++;
      else if (l.focus === "casual") focusCounts.casual++;
      else if (l.focus === "distracted") focusCounts.distracted++;

      const pName = (l.projects && l.projects[0]) || (l.project_id ? projectNames.get(l.project_id) : null);
      const noteContent = l.notes?.trim() || l.summary?.trim();

      if (pName) {
        if (!projectMap.has(pName)) {
          projectMap.set(pName, { minutes: 0, notes: [] });
        }
        const entry = projectMap.get(pName)!;
        entry.minutes += l.value || 0;
        if (noteContent && !entry.notes.includes(noteContent)) {
          entry.notes.push(noteContent);
        }
      } else {
        if (noteContent && !generalNotes.includes(noteContent)) {
          generalNotes.push(noteContent);
        }
      }
    }

    const projects: Array<{ name: string; minutes: number; notes: string[] }> = [];
    for (const [name, pData] of projectMap.entries()) {
      projects.push({
        name,
        minutes: pData.minutes,
        notes: pData.notes,
      });
    }

    tasksWorkedOn.push({
      task: t,
      totalMin: taskTotalMin,
      pctOfTarget,
      targetMin,
      projects,
      generalNotes,
      focusCounts,
    });
  }

  // 5. Habits / Routines (tick & counter tasks)
  const nonTimerTasks = allTasks.filter((t) => t.type !== "timer" && !t.is_system);
  const habits: DailySummaryData["habits"] = [];

  for (const t of nonTimerTasks) {
    const taskLogs = logs.filter((l) => l.task_name === t.name);
    const sumVal = taskLogs.reduce((acc, l) => acc + (l.value || 0), 0);

    if (t.type === "tick") {
      habits.push({
        name: t.name,
        type: "tick",
        isDone: sumVal > 0,
        valDisplay: sumVal > 0 ? "Completed" : "Missed",
      });
    } else {
      const target = t.target_value || 1;
      const unit = t.unit?.includes("|") ? t.unit.split("|")[0] : t.unit || "units";
      habits.push({
        name: t.name,
        type: "counter",
        isDone: sumVal >= target,
        valDisplay: `${sumVal.toLocaleString()} / ${target.toLocaleString()} ${unit}`,
      });
    }
  }

  // 6. Diary entries
  const diaryLogs = logs.filter((l) => l.task_name === "Diary");
  const diaryEntries: DailySummaryData["diaryEntries"] = diaryLogs.map((d) => ({
    time: d.created_at ? localTimeString(new Date(d.created_at)) : "",
    mood: d.mood || null,
    content: d.summary || d.notes || "",
  }));

  // Nicely formatted date label: "Tuesday, Nov 3, 2026"
  const dateObj = new Date(`${date}T12:00:00Z`);
  const dateFormatted = dateObj.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return {
    date,
    dateFormatted,
    totalFocusMin,
    sleepMin,
    wastedMin,
    tasksWorkedOn,
    completedTodos,
    incompleteTodos,
    habits,
    diaryEntries,
  };
}

/**
 * Render responsive HTML email template
 */
export function renderEmailHtml(data: DailySummaryData): string {
  const {
    dateFormatted,
    totalFocusMin,
    sleepMin,
    wastedMin,
    tasksWorkedOn,
    completedTodos,
    incompleteTodos,
    habits,
    diaryEntries,
  } = data;

  const focusHours = formatTimerMinutes(totalFocusMin);
  const sleepHours = formatTimerMinutes(sleepMin);
  const wastedHours = formatTimerMinutes(wastedMin);

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daily Summary — ${dateFormatted}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #f4f6f9;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #1f2937;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      max-width: 640px;
      margin: 24px auto;
      background: #ffffff;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 4px 16px rgba(0,0,0,0.06);
      border: 1px solid #e5e7eb;
    }
    .header {
      background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%);
      padding: 32px 28px;
      color: #ffffff;
    }
    .header h1 {
      margin: 0 0 6px 0;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .header p {
      margin: 0;
      font-size: 14px;
      opacity: 0.92;
    }
    .stats-grid {
      display: table;
      width: 100%;
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
    }
    .stat-cell {
      display: table-cell;
      width: 25%;
      padding: 16px 12px;
      text-align: center;
      border-right: 1px solid #e2e8f0;
    }
    .stat-cell:last-child {
      border-right: none;
    }
    .stat-val {
      font-size: 18px;
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 2px;
    }
    .stat-lbl {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #64748b;
    }
    .content {
      padding: 24px 28px;
    }
    .card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .card-title {
      margin: 0 0 14px 0;
      font-size: 16px;
      font-weight: 700;
      color: #111827;
      display: flex;
      align-items: center;
    }
    .tag {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 6px;
      margin-left: 8px;
    }
    .tag-danger {
      background: #fee2e2;
      color: #991b1b;
    }
    .tag-success {
      background: #dcfce7;
      color: #166534;
    }
    .task-item {
      padding: 12px 0;
      border-bottom: 1px solid #f1f5f9;
    }
    .task-item:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }
    .task-name {
      font-size: 15px;
      font-weight: 600;
      color: #1e293b;
    }
    .task-meta {
      font-size: 12px;
      color: #64748b;
      margin-top: 3px;
    }
    .progress-bar-bg {
      background: #e2e8f0;
      border-radius: 999px;
      height: 6px;
      margin: 8px 0;
      overflow: hidden;
    }
    .progress-bar-fill {
      background: #3b82f6;
      height: 100%;
      border-radius: 999px;
    }
    .notes-box {
      background: #f8fafc;
      border-left: 3px solid #cbd5e1;
      padding: 8px 12px;
      margin-top: 8px;
      border-radius: 0 6px 6px 0;
      font-size: 13px;
      color: #475569;
    }
    .project-chip {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      background: #ede9fe;
      color: #5b21b6;
      padding: 2px 7px;
      border-radius: 4px;
      margin-right: 6px;
    }
    .todo-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .todo-item {
      padding: 8px 0;
      font-size: 14px;
      display: flex;
      align-items: flex-start;
      border-bottom: 1px solid #f8fafc;
    }
    .todo-item:last-child {
      border-bottom: none;
    }
    .todo-icon {
      margin-right: 10px;
      font-size: 14px;
    }
    .incomplete-card {
      border-color: #fecaca;
      background: #fffafa;
    }
    .incomplete-title {
      color: #b91c1c;
    }
    .footer {
      padding: 20px 28px;
      text-align: center;
      font-size: 12px;
      color: #9ca3af;
      background: #fafafa;
      border-top: 1px solid #f3f4f6;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <!-- Header -->
    <div class="header">
      <h1>📊 Yesterday's Daily Debrief</h1>
      <p>${dateFormatted} · Automated Life-Log Summary</p>
    </div>

    <!-- Top KPI Grid -->
    <div class="stats-grid">
      <div class="stat-cell">
        <div class="stat-val">${focusHours}</div>
        <div class="stat-lbl">Focus Time</div>
      </div>
      <div class="stat-cell">
        <div class="stat-val" style="color: #16a34a;">${completedTodos.length}</div>
        <div class="stat-lbl">Completed</div>
      </div>
      <div class="stat-cell">
        <div class="stat-val" style="color: ${incompleteTodos.length > 0 ? '#dc2626' : '#64748b'};">${incompleteTodos.length}</div>
        <div class="stat-lbl">Incomplete</div>
      </div>
      <div class="stat-cell">
        <div class="stat-val">${wastedHours}</div>
        <div class="stat-lbl">Unaccounted</div>
      </div>
    </div>

    <div class="content">
      <!-- Incomplete Tasks (Carried Over) -->
      ${
        incompleteTodos.length > 0
          ? `
      <div class="card incomplete-card">
        <div class="card-title incomplete-title">
          ⚠️ Incomplete Tasks &amp; To-Dos
          <span class="tag tag-danger">${incompleteTodos.length} Pending</span>
        </div>
        <p style="margin: 0 0 10px 0; font-size: 13px; color: #7f1d1d;">
          These tasks were scheduled for yesterday but were not checked off:
        </p>
        <ul class="todo-list">
          ${incompleteTodos
            .map(
              (td) => `
            <li class="todo-item">
              <span class="todo-icon">❌</span>
              <div>
                <strong>${td.title}</strong>
                ${td.projectName ? `<span class="project-chip" style="margin-left: 8px;">📁 ${td.projectName}</span>` : ""}
                ${td.taskName ? `<span style="font-size: 12px; color: #6b7280;">(${td.taskName})</span>` : ""}
              </div>
            </li>
          `
            )
            .join("")}
        </ul>
      </div>
      `
          : ""
      }

      <!-- Tasks Worked On & Projects -->
      <div class="card">
        <div class="card-title">
          ⏱️ Tasks &amp; Focus Sessions
          <span class="tag" style="background: #e0f2fe; color: #0369a1;">${tasksWorkedOn.length} Active</span>
        </div>
        ${
          tasksWorkedOn.length === 0
            ? `<p style="margin: 0; color: #6b7280; font-size: 13px;">No focus timer sessions recorded yesterday.</p>`
            : tasksWorkedOn
                .map((item) => {
                  const pct = Math.min(100, item.pctOfTarget);
                  const focusTag =
                    item.focusCounts.focused || item.focusCounts.casual || item.focusCounts.distracted
                      ? `🎯 ${item.focusCounts.focused} · 😐 ${item.focusCounts.casual} · 😵 ${item.focusCounts.distracted}`
                      : "";

                  return `
            <div class="task-item">
              <div style="display: flex; justify-content: space-between; align-items: baseline;">
                <span class="task-name">${taskEmoji(item.task)} ${item.task.name}</span>
                <span style="font-size: 13px; font-weight: 700; color: #1e293b;">
                  ${formatTimerMinutes(item.totalMin)} <span style="font-weight: 400; color: #64748b;">/ ${formatTimerMinutes(item.targetMin)} (${pct}%)</span>
                </span>
              </div>

              <div class="progress-bar-bg">
                <div class="progress-bar-fill" style="width: ${pct}%;"></div>
              </div>

              ${focusTag ? `<div class="task-meta">Quality: ${focusTag}</div>` : ""}

              ${
                item.projects.length > 0
                  ? item.projects
                      .map(
                        (p) => `
                  <div class="notes-box">
                    <span class="project-chip">📁 ${p.name}</span>
                    <strong style="color: #334155;">${formatTimerMinutes(p.minutes)}</strong>
                    ${
                      p.notes.length > 0
                        ? `<div style="margin-top: 4px; color: #475569;">${p.notes.join("<br>• ")}</div>`
                        : ""
                    }
                  </div>
                `
                      )
                      .join("")
                  : ""
              }

              ${
                item.generalNotes.length > 0
                  ? `
                <div class="notes-box" style="margin-top: 6px;">
                  <strong style="color: #475569;">Session Notes:</strong><br>
                  ${item.generalNotes.map((n) => `• ${n}`).join("<br>")}
                </div>
              `
                  : ""
              }
            </div>
          `;
                })
                .join("")
        }
      </div>

      <!-- Completed Tasks & To-Dos -->
      ${
        completedTodos.length > 0
          ? `
      <div class="card">
        <div class="card-title">
          ✅ Completed Accomplishments
          <span class="tag tag-success">${completedTodos.length} Done</span>
        </div>
        <ul class="todo-list">
          ${completedTodos
            .map(
              (td) => `
            <li class="todo-item">
              <span class="todo-icon">✅</span>
              <div>
                <span style="color: #374151;">${td.title}</span>
                ${td.projectName ? `<span class="project-chip" style="margin-left: 8px;">📁 ${td.projectName}</span>` : ""}
                ${td.taskName ? `<span style="font-size: 12px; color: #6b7280;">(${td.taskName})</span>` : ""}
              </div>
            </li>
          `
            )
            .join("")}
        </ul>
      </div>
      `
          : ""
      }

      <!-- Habits & Routines -->
      ${
        habits.length > 0
          ? `
      <div class="card">
        <div class="card-title">
          📌 Daily Habits &amp; Routines
        </div>
        <ul class="todo-list">
          ${habits
            .map(
              (h) => `
            <li class="todo-item">
              <span class="todo-icon">${h.isDone ? "✅" : "⭕"}</span>
              <div style="flex-grow: 1; display: flex; justify-content: space-between;">
                <span><strong>${h.name}</strong></span>
                <span style="color: ${h.isDone ? "#16a34a" : "#dc2626"}; font-size: 13px; font-weight: 600;">
                  ${h.valDisplay}
                </span>
              </div>
            </li>
          `
            )
            .join("")}
        </ul>
      </div>
      `
          : ""
      }

      <!-- Sleep & Unaccounted Time Audit -->
      <div class="card">
        <div class="card-title">
          🕳️ 24-Hour Time Accountability
        </div>
        <div style="display: table; width: 100%; font-size: 13px;">
          <div style="display: table-row;">
            <div style="display: table-cell; padding: 6px 0; color: #4b5563;">⏱️ Focused Sessions:</div>
            <div style="display: table-cell; padding: 6px 0; text-align: right; font-weight: 600;">${focusHours}</div>
          </div>
          <div style="display: table-row;">
            <div style="display: table-cell; padding: 6px 0; color: #4b5563;">😴 Sleep Tracked:</div>
            <div style="display: table-cell; padding: 6px 0; text-align: right; font-weight: 600;">${sleepHours}</div>
          </div>
          <div style="display: table-row; border-top: 1px solid #f1f5f9;">
            <div style="display: table-cell; padding: 6px 0; color: #dc2626; font-weight: 600;">🕳️ Wasted / Unaccounted:</div>
            <div style="display: table-cell; padding: 6px 0; text-align: right; font-weight: 700; color: #dc2626;">${wastedHours}</div>
          </div>
        </div>
      </div>

      <!-- Diary & Notes -->
      ${
        diaryEntries.length > 0
          ? `
      <div class="card">
        <div class="card-title">
          📖 Diary &amp; Reflections
        </div>
        ${diaryEntries
          .map(
            (d) => `
          <div style="padding: 8px 0; border-bottom: 1px solid #f1f5f9;">
            <div style="font-size: 12px; color: #64748b; margin-bottom: 3px;">
              ${d.time ? `🕐 ${d.time}` : ""} ${d.mood ? `· Mood: [${formatMoodDisplay(d.mood)}]` : ""}
            </div>
            <div style="font-size: 14px; color: #1f2937; line-height: 1.5;">${d.content}</div>
          </div>
        `
          )
          .join("")}
      </div>
      `
          : ""
      }
    </div>

    <!-- Footer -->
    <div class="footer">
      Generated automatically by your open-source Life-Log Bot · Clean &amp; Private
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Plain text fallback for simple clients
 */
export function renderEmailText(data: DailySummaryData): string {
  const {
    dateFormatted,
    totalFocusMin,
    sleepMin,
    wastedMin,
    tasksWorkedOn,
    completedTodos,
    incompleteTodos,
    habits,
    diaryEntries,
  } = data;

  let text = `DAILY SUMMARY DEBRIEF — ${dateFormatted}\n`;
  text += `=================================================\n\n`;
  text += `FOCUS TIME: ${formatTimerMinutes(totalFocusMin)}\n`;
  text += `SLEEP: ${formatTimerMinutes(sleepMin)}\n`;
  text += `UNACCOUNTED: ${formatTimerMinutes(wastedMin)}\n`;
  text += `COMPLETED TASKS: ${completedTodos.length}\n`;
  text += `INCOMPLETE TASKS: ${incompleteTodos.length}\n\n`;

  if (incompleteTodos.length > 0) {
    text += `⚠️ INCOMPLETE TASKS (CARRIED OVER):\n`;
    for (const td of incompleteTodos) {
      text += ` [ ] ${td.title}${td.projectName ? ` (Project: ${td.projectName})` : ""}\n`;
    }
    text += `\n`;
  }

  text += `⏱️ TASKS WORKED ON:\n`;
  for (const item of tasksWorkedOn) {
    text += `• ${item.task.name}: ${formatTimerMinutes(item.totalMin)} / ${formatTimerMinutes(item.targetMin)} (${item.pctOfTarget}%)\n`;
    for (const p of item.projects) {
      text += `   - Project: ${p.name} (${formatTimerMinutes(p.minutes)})\n`;
      for (const n of p.notes) {
        text += `     * ${n}\n`;
      }
    }
    for (const n of item.generalNotes) {
      text += `   * ${n}\n`;
    }
  }
  text += `\n`;

  if (completedTodos.length > 0) {
    text += `✅ COMPLETED ACCOMPLISHMENTS:\n`;
    for (const td of completedTodos) {
      text += ` [x] ${td.title}${td.projectName ? ` (Project: ${td.projectName})` : ""}\n`;
    }
    text += `\n`;
  }

  if (habits.length > 0) {
    text += `📌 HABITS & ROUTINES:\n`;
    for (const h of habits) {
      text += `• ${h.name}: ${h.valDisplay}\n`;
    }
    text += `\n`;
  }

  if (diaryEntries.length > 0) {
    text += `📖 DIARY ENTRIES:\n`;
    for (const d of diaryEntries) {
      text += `• ${d.time ? `[${d.time}] ` : ""}${d.mood ? `(${d.mood}) ` : ""}${d.content}\n`;
    }
  }

  return text;
}

/**
 * Main function: Build and send yesterday's daily summary email.
 */
export async function sendDailySummaryEmail(
  targetDate?: string,
  recipientOverride?: string
): Promise<EmailSendResult & { summary?: DailySummaryData }> {
  try {
    const data = await getDailySummaryData(targetDate);
    const html = renderEmailHtml(data);
    const text = renderEmailText(data);
    const subject = `📊 Daily Summary: ${data.dateFormatted} (${formatTimerMinutes(data.totalFocusMin)} focus, ${data.incompleteTodos.length} incomplete)`;

    const result = await sendEmail({
      to: recipientOverride || process.env.SUMMARY_EMAIL_TO || "",
      subject,
      html,
      text,
    });

    return {
      ...result,
      summary: data,
    };
  } catch (err: any) {
    console.error("Error building or sending daily summary email:", err);
    return {
      sent: false,
      reason: "error",
      error: err.message,
    };
  }
}

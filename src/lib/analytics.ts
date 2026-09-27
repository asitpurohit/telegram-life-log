import { GoogleGenAI, Type, ToolUnion } from "@google/genai";
import { supabase, getActiveTasks, getTodos, getFocusTotals, getLogsInRange, getAnyActiveTimer } from "./supabase";
import { computeWastedDays, shiftDateString } from "./timeAudit";
import { localDateString, todoDueLabel } from "./time";

const apiKey = process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({ apiKey });

type ToolArgs = Record<string, any>;

// ---- Read-only tools the AI can call (the app executes them, never Gemini) ----

function clampRange(from?: string, to?: string): { from: string; to: string } {
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  const today = localDateString();
  let f = from && isoDate.test(from) ? from : localDateString(new Date(Date.now() - 6 * 86400000));
  let t = to && isoDate.test(to) ? to : today;
  if (f > t) [f, t] = [t, f];

  // Never scan more than 400 days in one call
  const maxStart = localDateString(new Date(new Date(`${t}T00:00:00Z`).getTime() - 400 * 86400000));
  if (f < maxStart) f = maxStart;
  return { from: f, to: t };
}

async function toolGetTasks() {
  const tasks = await getActiveTasks();
  return {
    tasks: tasks.map((t) => ({
      name: t.name,
      type: t.type,
      goal: t.target_value,
      unit: t.unit,
      reminder: t.reminder_time,
      days: t.target_days,
    })),
  };
}

async function toolGetLogs(args: ToolArgs) {
  const { from, to } = clampRange(args.from, args.to);
  let query = supabase
    .from("logs")
    .select("created_at, started_at, log_date, task_name, value, notes, mood, focus, summary")
    .gte("log_date", from)
    .lte("log_date", to)
    .order("log_date", { ascending: true })
    .limit(500);

  if (args.task) query = query.ilike("task_name", `%${String(args.task)}%`);

  const { data, error } = await query;
  if (error) return { error: error.message };

  return {
    from,
    to,
    count: data?.length || 0,
    logs: (data || []).map((l) => ({
      created_at: l.created_at || undefined,
      started_at: l.started_at || undefined,
      date: l.log_date,
      task: l.task_name,
      value: l.value,
      mood: l.mood || undefined,
      focus: l.focus || undefined,
      note: l.notes ? String(l.notes).slice(0, 200) : undefined,
    })),
  };
}

async function toolGetFocus(args: ToolArgs) {
  const { from, to } = clampRange(args.from, args.to);
  const rows = await getFocusTotals(from, to, args.task);

  const pct = (v: number, tagged: number) => (tagged ? Math.round((v / tagged) * 100) : 0);

  return {
    from,
    to,
    note: "Percentages are weighted by entry value (minutes/count) and exclude untagged entries.",
    tasks: rows.map((r) => ({
      task: r.task,
      focused: r.focused,
      casual: r.casual,
      distracted: r.distracted,
      tagged: r.tagged,
      focusedPct: pct(r.focused, r.tagged),
      casualPct: pct(r.casual, r.tagged),
      distractedPct: pct(r.distracted, r.tagged),
      score: r.tagged ? Math.round(((r.focused - r.distracted) / r.tagged) * 100) / 100 : 0,
    })),
  };
}

async function toolGetSummary(args: ToolArgs) {
  const { from, to } = clampRange(args.from, args.to);
  let query = supabase
    .from("logs")
    .select("log_date, task_name, value")
    .gte("log_date", from)
    .lte("log_date", to)
    .limit(2000);

  if (args.task) query = query.ilike("task_name", `%${String(args.task)}%`);

  const { data, error } = await query;
  if (error) return { error: error.message };

  const totalsMap = new Map<string, number>();
  for (const row of data || []) {
    const key = `${row.log_date}|${row.task_name}`;
    totalsMap.set(key, (totalsMap.get(key) || 0) + (row.value || 0));
  }

  const tasks = await getActiveTasks();
  return {
    from,
    to,
    goals: tasks.map((t) => ({ task: t.name, type: t.type, goal: t.target_value, unit: t.unit })),
    totals: Array.from(totalsMap.entries()).map(([key, total]) => {
      const [date, task] = key.split("|");
      return { date, task, total };
    }),
  };
}

function snippetAround(text: string, keyword: string, radius = 90): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(keyword.toLowerCase());
  if (idx < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + keyword.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

async function toolSearchLogs(args: ToolArgs) {
  const keyword = String(args.keyword || "").trim();
  if (keyword.length < 2) return { error: "keyword too short" };

  // Strip PostgREST filter syntax characters so the keyword can't break the query
  const safe = keyword.replace(/[%,()*\\]/g, " ").trim();
  if (!safe) return { error: "invalid keyword" };

  let query = supabase
    .from("logs")
    .select("log_date, task_name, notes, summary, mood")
    .or(`notes.ilike.%${safe}%,summary.ilike.%${safe}%`)
    .order("log_date", { ascending: false })
    .limit(100);

  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (args.from && isoDate.test(String(args.from))) query = query.gte("log_date", String(args.from));
  if (args.to && isoDate.test(String(args.to))) query = query.lte("log_date", String(args.to));
  if (args.task) query = query.ilike("task_name", `%${String(args.task)}%`);

  const { data, error } = await query;
  if (error) return { error: error.message };

  return {
    keyword,
    count: data?.length || 0,
    matches: (data || []).map((row) => ({
      date: row.log_date,
      task: row.task_name,
      mood: row.mood || undefined,
      summary: row.summary || undefined,
      snippet: row.notes ? snippetAround(String(row.notes), keyword) : undefined,
    })),
  };
}

async function toolGetTodos(args: ToolArgs) {
  const todos = await getTodos();
  let filtered = todos;
  if (args.status === "pending") filtered = todos.filter((t) => !t.is_done);
  if (args.status === "done") filtered = todos.filter((t) => t.is_done);

  return {
    todos: filtered.slice(0, 200).map((t) => ({
      title: t.title,
      due: todoDueLabel(t.due_at),
      done: t.is_done,
      done_at: t.done_at || undefined,
    })),
  };
}

async function toolGetWastedTime(args: ToolArgs) {
  const { from, to } = clampRange(args.from, args.to);
  const tasks = await getActiveTasks();
  const logs = await getLogsInRange(shiftDateString(from, -1), shiftDateString(to, 1));
  const running = await getAnyActiveTimer();

  const dates: string[] = [];
  for (let d = from; d <= to; d = shiftDateString(d, 1)) {
    dates.push(d);
    if (dates.length >= 400) break;
  }

  const days = computeWastedDays({ dates, logs, tasks, running });
  if (days.length === 0) return { from, to, note: "No completed days in this range yet." };

  const completed = days.filter((d) => !d.isToday);
  const avg = completed.length
    ? Math.round(completed.reduce((s, d) => s + d.wastedMin, 0) / completed.length)
    : null;

  return {
    from,
    to,
    note: "Past days are full 24h; today is partial (midnight -> now). Tracked time = every timer session overlapping the day (Sleep included; crossing nights are already split per day) + the live share of any running session. If no Sleep session covers the 22:00-05:00 night, an estimate is added and marked estimatedSleep. Values are minutes, clamped at 0.",
    days: days.map((d) => ({
      date: d.date,
      elapsedMin: d.elapsedMin,
      taskMinutes: d.taskMin,
      sleepMinutes: d.sleepMin,
      estimatedSleep: d.estimated,
      partialDay: d.isToday,
      wastedMinutes: d.wastedMin,
    })),
    totalWastedMinutes: days.reduce((s, d) => s + d.wastedMin, 0),
    avgWastedMinutesCompletedDays: avg,
  };
}

export async function executeAnalyticsTool(name: string, args: ToolArgs = {}): Promise<object> {
  try {
    switch (name) {
      case "get_tasks":
        return await toolGetTasks();
      case "get_logs":
        return await toolGetLogs(args);
      case "get_summary":
        return await toolGetSummary(args);
      case "search_logs":
        return await toolSearchLogs(args);
      case "get_focus":
        return await toolGetFocus(args);
      case "get_wasted_time":
        return await toolGetWastedTime(args);
      case "get_todos":
        return await toolGetTodos(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err: any) {
    return { error: err.message || "Tool failed" };
  }
}

// ---- The /ask loop: question -> Gemini picks tools -> app runs them -> answer ----

export async function askAboutData(question: string, knownTaskNames: string[] = []): Promise<string> {
  if (!apiKey) return "⚠️ AI is not configured (missing GEMINI_API_KEY).";

  const today = localDateString();
  const systemInstruction = `You are the analytics assistant for a personal habit & life-log app.
Today is ${today} (timezone IST, India).
Known tasks: ${JSON.stringify(knownTaskNames)}

Rules:
- ALWAYS call the tools to fetch real data before answering. Never invent numbers.
- Use get_summary for totals/percentages/averages, get_logs for details and diary notes, get_tasks for goals, get_todos for to-dos.
- Use search_logs for keyword/text searches (e.g. "when did I mention KTX2", "find entries about the game").
- Use get_focus for focus/concentration questions (focused / casual / distracted, percentages and score). Untagged entries are excluded from those percentages.
- IMPORTANT: diary entries describe work done on tasks. For questions like "what did I do in <task>" or "when did I do <task>", ALWAYS call search_logs with the task name as the keyword, because the details live in diary notes. You may also call get_logs/get_summary for that task to add totals.
- Only say there is no data when both the task tools AND search_logs return nothing.
- Timer goals are in minutes; counters are in their unit; tick tasks count as 1 completion.
- For wasted/unaccounted time questions (e.g. "how much time did I waste yesterday/this week"), ALWAYS call get_wasted_time with the exact date range — never compute it yourself from other tools. Explain using its note: past days are full 24h, today is partial.
- For sleep or duration questions (e.g. "how long did I sleep"), use get_logs for the Sleep task: each session row stores started_at and created_at, and nights crossing midnight are split into one row per day.
- Compute percentages against each task's goal where relevant.
- Answer concisely and friendly, formatted for Telegram HTML (<b>, <i>, <code>). No markdown tables.
- If the question is not about the user's data, answer briefly.`;

  const tools: ToolUnion[] = [
    {
      functionDeclarations: [
        {
          name: "get_tasks",
          description: "Get the user's active habits/tasks with goals, units, reminder times and schedules.",
          parameters: { type: Type.OBJECT, properties: {} },
        },
        {
          name: "get_logs",
          description:
            "Get detailed activity logs (sessions, counts, diary notes, mood) in a date range, optionally filtered by task. Each log includes created_at (the exact timestamp when it was recorded); timer-session logs also include started_at (when the session began).",
          parameters: {
            type: Type.OBJECT,
            properties: {
              from: { type: Type.STRING, description: "Start date, YYYY-MM-DD" },
              to: { type: Type.STRING, description: "End date, YYYY-MM-DD" },
              task: { type: Type.STRING, description: "Optional exact task name filter" },
            },
            required: ["from", "to"],
          },
        },
        {
          name: "get_summary",
          description:
            "Get aggregated daily totals per task for a date range. Best for totals, percentages, averages and trends.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              from: { type: Type.STRING, description: "Start date, YYYY-MM-DD" },
              to: { type: Type.STRING, description: "End date, YYYY-MM-DD" },
              task: { type: Type.STRING, description: "Optional exact task name filter" },
            },
            required: ["from", "to"],
          },
        },
        {
          name: "search_logs",
          description:
            "Case-insensitive keyword search inside log/diary notes and summaries. Use for questions like 'when did I mention X' or 'find entries about Y'. Searches all time unless from/to are given.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              keyword: { type: Type.STRING, description: "Word or phrase to search for" },
              from: { type: Type.STRING, description: "Optional start date, YYYY-MM-DD" },
              to: { type: Type.STRING, description: "Optional end date, YYYY-MM-DD" },
              task: { type: Type.STRING, description: "Optional task name filter" },
            },
            required: ["keyword"],
          },
        },
        {
          name: "get_focus",
          description:
            "Get per-session focus analytics for tasks: focused / casual / distracted totals, percentages (weighted by minutes or count) and a focus score (−1 to +1). Use for questions about focus, concentration or distraction. Untagged entries are excluded.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              from: { type: Type.STRING, description: "Start date, YYYY-MM-DD" },
              to: { type: Type.STRING, description: "End date, YYYY-MM-DD" },
              task: { type: Type.STRING, description: "Optional task name filter" },
            },
            required: ["from", "to"],
          },
        },
        {
          name: "get_wasted_time",
          description:
            "Compute wasted (unaccounted) time per day over a date range: elapsed (24h for past days, midnight->now for today) minus tracked timer sessions (Sleep included; crossing nights are already split per day; a running session counts live). If no Sleep session covers the 22:00-05:00 night, an estimate is added and marked estimatedSleep. Use ONLY for wasted/unaccounted time questions.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              from: { type: Type.STRING, description: "Start date, YYYY-MM-DD" },
              to: { type: Type.STRING, description: "End date, YYYY-MM-DD" },
            },
            required: ["from", "to"],
          },
        },
        {
          name: "get_todos",
          description: "Get one-time to-dos with their due times and done status.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              status: { type: Type.STRING, description: "pending | done | all" },
            },
          },
        },
      ],
    },
  ];

  const modelsToTry = [
    "gemini-flash-lite-latest",
    "gemini-3.5-flash-lite",
    "gemini-flash-latest",
    "gemini-3.5-flash",
    "gemini-3.8-flash",
  ];

  for (const modelName of modelsToTry) {
    try {
      const chat = ai.chats.create({
        model: modelName,
        config: { tools, systemInstruction },
      });

      let response = await chat.sendMessage({ message: `User question: ${question}` });

      for (let i = 0; i < 3; i++) {
        const calls = response.functionCalls;
        if (!calls || calls.length === 0) break;

        const responseParts = [];
        for (const call of calls) {
          const toolName = call.name || "";
          const output = (await executeAnalyticsTool(toolName, (call.args || {}) as ToolArgs)) as Record<string, unknown>;
          responseParts.push({ functionResponse: { name: toolName, response: output } });
        }
        response = await chat.sendMessage({ message: responseParts });
      }

      const text = response.text;
      if (text && text.trim()) return text.trim().slice(0, 3900);
    } catch (err: any) {
      console.warn(`Ask model ${modelName} failed:`, err.message || err);
    }
  }

  return "⚠️ Couldn't get an answer right now (AI unavailable or quota reached). Please try again later.";
}

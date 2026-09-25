import { GoogleGenAI, Type, ToolUnion } from "@google/genai";
import { supabase, getActiveTasks, getTodos } from "./supabase";
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
    .select("log_date, task_name, value, notes, mood, summary")
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
      date: l.log_date,
      task: l.task_name,
      value: l.value,
      mood: l.mood || undefined,
      note: l.notes ? String(l.notes).slice(0, 200) : undefined,
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

export async function executeAnalyticsTool(name: string, args: ToolArgs = {}): Promise<object> {
  try {
    switch (name) {
      case "get_tasks":
        return await toolGetTasks();
      case "get_logs":
        return await toolGetLogs(args);
      case "get_summary":
        return await toolGetSummary(args);
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
- Timer goals are in minutes; counters are in their unit; tick tasks count as 1 completion.
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
            "Get detailed activity logs (sessions, counts, diary notes, mood) in a date range, optionally filtered by task.",
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

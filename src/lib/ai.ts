import { GoogleGenerativeAI } from "@google/generative-ai";

const apiKey = process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(apiKey);

export interface AIParsedIntent {
  intent: "CREATE_TASK" | "START_TIMER" | "STOP_TIMER" | "ADD_WATER" | "DIARY_ENTRY" | "QUERY" | "UNKNOWN";
  isMeaningful: boolean; // true if text is meaningful human reflection/activity/query; false if gibberish, keyboard mash, random nonsense, abrupt noise, or accidental spam
  reason?: string;
  task?: {
    name: string;
    type: "timer" | "counter" | "tick";
    reminder_time?: string | null; // e.g. "08:00:00"
    target_value?: number | null; // e.g. 60 or 5000
    unit?: string | null;
  };
  diary?: {
    summary: string;
    people: string[];
    projects: string[];
    decisions: string[];
    mood?: string;
  };
  queryQuestion?: string;
  waterAmount?: number;
  timerTaskName?: string;
  replyMessage?: string;
}

export function isQuickGibberishCheck(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return true;
  // Non-alphanumeric only (e.g. "...", "???", "!@#$")
  if (/^[^a-zA-Z0-9]+$/.test(t)) return true;
  // Repeated single character 4+ times (e.g. "aaaaa", "zzzzz")
  if (/(.)\1{3,}/i.test(t)) return true;
  return false;
}

export async function parseUserMessageWithAI(
  userText: string,
  existingTaskNames: string[] = []
): Promise<AIParsedIntent> {
  if (isQuickGibberishCheck(userText)) {
    return {
      intent: "UNKNOWN",
      isMeaningful: false,
      reason: "Text consists of repetitive characters or symbols with no semantic meaning.",
      replyMessage: "",
    };
  }

  if (!apiKey) {
    console.warn("GEMINI_API_KEY not configured, using fallback parsing.");
    return fallbackParser(userText, existingTaskNames);
  }

  const prompt = `
You are the AI brain of a personal life-log & habit assistant.
The user sent this message in Telegram:
"${userText}"

Known existing tasks: ${JSON.stringify(existingTaskNames)}

First, evaluate whether the user message is MEANINGFUL or MEANINGLESS/GIBBERISH:
- Set "isMeaningful": true if the text expresses genuine human thoughts, activities, habits, reflections, questions, or requests (e.g. "studied physics", "finished chapter 3", "drank 500ml", "feeling great today").
- Set "isMeaningful": false if the text is random keyboard mashing (e.g. "ishusabuasuasuasbsa", "asdfghjkl"), nonsense characters, repetitive symbols, or abrupt incoherent noise with no semantic meaning.
- If "isMeaningful" is false, provide a brief "reason" explaining why, and set intent to "UNKNOWN".

Classify the user's intent into ONE of these:
1. CREATE_TASK: User wants to define/create a new habit or task (e.g. "remind me at 8 am to study physics", "add task wake up at 5am", "add counter task 5 liter water").
   Extract:
   - name: concise title (e.g. "Physics Study", "Drink Water", "Wake Up")
   - type: "timer" (for activities with duration like study/work), "counter" (for measurable amounts like water/steps), "tick" (for checkbox items like waking up)
   - reminder_time: "HH:MM:SS" (24h format) or null
   - target_value: number (e.g. 60 for 60 mins, 5000 for 5000ml) or null
   - unit: "minutes", "ml", or "status"

2. START_TIMER: User wants to start working on a task now (e.g. "starting physics", "start 3d game dev").
   Extract timerTaskName.

3. STOP_TIMER: User wants to stop/end an active timer (e.g. "done studying", "stop timer", "finished work").

4. ADD_WATER: User logged water intake (e.g. "drank 500ml", "water 1 glass").
   Extract waterAmount (in ml, default 250ml if 1 glass).

5. DIARY_ENTRY: User is journaling about their day, thoughts, feelings, or activities.
   Extract:
   - summary: 1-2 sentence concise recap
   - people: array of names mentioned
   - projects: array of projects or study topics mentioned
   - decisions: array of decisions/conclusions made
   - mood: inferred overall mood of the day (e.g. "happy", "productive", "okay", "bad", "tired", "stressed", "grateful")

6. QUERY: User is asking a question about their past logs or status (e.g. "how much did I study?", "show my water logs").

7. UNKNOWN: Casual greeting, unrecognized statement, or meaningless gibberish.

Respond ONLY with valid JSON matching this schema:
{
  "isMeaningful": boolean,
  "reason": "short explanation",
  "intent": "CREATE_TASK" | "START_TIMER" | "STOP_TIMER" | "ADD_WATER" | "DIARY_ENTRY" | "QUERY" | "UNKNOWN",
  "task": { "name": "...", "type": "timer"|"counter"|"tick", "reminder_time": "HH:MM:SS"|null, "target_value": 0, "unit": "..." },
  "timerTaskName": "...",
  "waterAmount": 0,
  "diary": { "summary": "...", "people": [], "projects": [], "decisions": [], "mood": "happy"|"productive"|"okay"|"bad"|"tired"|"stressed"|"grateful" },
  "queryQuestion": "...",
  "replyMessage": "A warm, natural 1-sentence response"
}
`;

  const modelsToTry = [
    "gemini-flash-lite-latest",
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash",
    "gemini-flash-latest",
    "gemini-3.5-flash",
  ];

  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      });

      const responseText = result.response.text();
      const parsed: AIParsedIntent = JSON.parse(responseText);
      if (typeof parsed.isMeaningful !== "boolean") {
        parsed.isMeaningful = !isQuickGibberishCheck(userText);
      }
      return parsed;
    } catch (err: any) {
      console.warn(`Gemini model ${modelName} error, trying next fallback:`, err.message || err);
    }
  }

  return fallbackParser(userText, existingTaskNames);
}

function fallbackParser(text: string, existingTasks: string[]): AIParsedIntent {
  const lower = text.toLowerCase().trim();

  if (isQuickGibberishCheck(text)) {
    return {
      intent: "UNKNOWN",
      isMeaningful: false,
      reason: "Text appears to be accidental or meaningless characters.",
      replyMessage: "",
    };
  }

  if (lower.startsWith("water") || lower.includes("drank water")) {
    const match = lower.match(/\d+/);
    return {
      intent: "ADD_WATER",
      isMeaningful: true,
      waterAmount: match ? parseInt(match[0], 10) : 500,
      replyMessage: "Logged water intake!",
    };
  }

  if (lower.startsWith("start") || lower.includes("starting")) {
    return {
      intent: "START_TIMER",
      isMeaningful: true,
      timerTaskName: text.replace(/start(ing)?/i, "").trim() || "Work",
      replyMessage: "Starting timer!",
    };
  }

  if (lower.startsWith("stop") || lower.includes("done")) {
    return {
      intent: "STOP_TIMER",
      isMeaningful: true,
      replyMessage: "Stopping timer!",
    };
  }

  return {
    intent: "UNKNOWN",
    isMeaningful: lower.length >= 3 && !isQuickGibberishCheck(lower),
    replyMessage: "",
  };
}

import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({ apiKey });

export interface DiarySubject {
  task: string; // must match one of the known task names
  detail: string; // what was done (mentioned time stays as text)
}

export interface AIParsedIntent {
  isMeaningful: boolean;
  aiUsed?: boolean; // false when the offline fallback answered (AI down/quota)
  reason?: string;
  diary?: {
    summary: string;
    people: string[];
    projects: string[];
    decisions: string[];
    mood?: string;
  };
  subjects?: DiarySubject[];
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
      isMeaningful: false,
      aiUsed: false,
      reason: "Text consists of repetitive characters or symbols with no semantic meaning.",
    };
  }

  if (!apiKey) {
    console.warn("GEMINI_API_KEY not configured, using fallback parsing.");
    return fallbackParser(userText);
  }

  const prompt = `
You are the diary assistant for a personal life-log app.
The user's diary entry:
"${userText}"

Known tasks: ${JSON.stringify(existingTaskNames)}

Decide whether this is a genuine diary entry or meaningless noise:
- Set "isMeaningful": true for real reflections, activities, feelings or plans (e.g. "studied physics for 2 hours", "finished chapter 3", "feeling great today").
- Set "isMeaningful": false for random keyboard mashing, nonsense characters, repetitive symbols or incoherent noise.

If it is meaningful, extract:
- summary: 1-2 sentence concise recap
- people: array of names mentioned
- projects: array of projects or study topics mentioned
- decisions: array of decisions/conclusions made
- mood: inferred overall mood of the day (e.g. "happy", "productive", "okay", "bad", "tired", "stressed", "grateful")
- subjects: array of work done on a KNOWN task, each as { "task": "<exact name from Known tasks>", "detail": "<what was done; mentioned time is fine as text>" }
  Rules for subjects: only use names from the Known tasks list; only include a subject when a concrete detail of work done is mentioned; never invent tasks or details.

Respond ONLY with valid JSON matching this schema:
{
  "isMeaningful": boolean,
  "reason": "short explanation",
  "diary": { "summary": "...", "people": [], "projects": [], "decisions": [], "mood": "happy"|"productive"|"okay"|"bad"|"tired"|"stressed"|"grateful" },
  "subjects": [ { "task": "...", "detail": "..." } ]
}
`;

  const modelsToTry = [
    "gemini-flash-lite-latest",
    "gemini-3.5-flash-lite",
    "gemini-flash-latest",
    "gemini-3.5-flash",
    "gemini-3.8-flash",
  ];

  for (const modelName of modelsToTry) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: { responseMimeType: "application/json" },
      });

      const responseText = response.text ?? "";
      const parsed: AIParsedIntent = JSON.parse(responseText);
      if (typeof parsed.isMeaningful !== "boolean") {
        parsed.isMeaningful = !isQuickGibberishCheck(userText);
      }
      if (!Array.isArray(parsed.subjects)) {
        parsed.subjects = [];
      }
      parsed.aiUsed = true;
      return parsed;
    } catch (err: any) {
      console.warn(`Gemini model ${modelName} error, trying next fallback:`, err.message || err);
    }
  }

  return fallbackParser(userText);
}

function fallbackParser(text: string): AIParsedIntent {
  return {
    isMeaningful: text.trim().length >= 3 && !isQuickGibberishCheck(text),
    aiUsed: false,
  };
}

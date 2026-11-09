import { WizardSession } from "@/lib/types";
import { InlineKeyboard } from "@/lib/telegram";
import { formatDuration } from "@/lib/timerRuntime";
import { formatTimerMinutes } from "@/lib/timeAudit";
import { localDateShort } from "@/lib/time";

export function formatSplitSummary(parts?: { date: string; minutes: number }[]): string {
  if (!parts || parts.length < 2) return "";
  const last = parts.length - 1;
  const pieces = parts.map(
    (p, i) => `${formatTimerMinutes(p.minutes)} ${i === last ? "today" : `on ${localDateShort(p.date)}`}`
  );
  return `\n🔀 Split: ${pieces.join(" + ")}`;
}

export function buildCheckoutViewText(data: WizardSession["task_data"]): string {
  const projectLine = data.projectName ? `📦 Project: <b>${data.projectName}</b>\n` : "";
  const todoLine = data.todoTitle ? `🎯 Task: <b>${data.todoTitle}</b>\n` : "";
  const splitLine = data.splitStr ? `${data.splitStr}\n` : "";
  const durStr = data.durationSeconds ? formatDuration(data.durationSeconds) : "0s";
  const totalStr = formatTimerMinutes(data.totalToday || 0);
  const targetStr = formatTimerMinutes(data.target || 60);
  const pctStr = `${data.percent ?? 0}%`;

  const focusLabel =
    data.focus === "focused"
      ? "🎯 Focused"
      : data.focus === "distracted"
      ? "😵 Distracted"
      : "😐 Casual";
  const todoStatusStr = data.todoTitle
    ? `\n• Sub-task: <b>${data.todoStatus === "completed" ? "✅ Done" : "⏳ In Progress"}</b>`
    : "";
  const projectStatusStr = data.projectName
    ? `\n• Project: <b>${data.projectStatus === "completed" ? "🏁 Done" : "⏳ Keep Open"}</b>`
    : "";
  const noteStr = data.sessionNote
    ? `\n• Session Note: <i>"${data.sessionNote}"</i>`
    : data.isAddingNote
    ? `\n• Session Note: 💬 <i>Type note in chat below...</i>`
    : "";

  return (
    `🎉 <b>${data.taskName || "Task"} Session Completed!</b>\n\n` +
    projectLine +
    todoLine +
    `⏱️ This Session: <b>${durStr}</b>\n` +
    `📊 Today's Total: <b>${totalStr} / ${targetStr}</b> (${pctStr} of daily goal)\n\n` +
    `• Focus: <b>${focusLabel}</b>` +
    todoStatusStr +
    projectStatusStr +
    noteStr +
    `\n` +
    splitLine +
    (data.isAddingNote
      ? `\n💬 <b>Type your note in chat below</b> (it will attach here),\nor tap options below:`
      : `\n<i>Adjust options below, then tap Done & Back to Tasks:</i>`)
  );
}

export function buildCheckoutKeyboard(data: WizardSession["task_data"]): InlineKeyboard {
  const kb: InlineKeyboard = [];

  // Sub-task row (only if todoId exists)
  if (data.todoId) {
    const isDone = data.todoStatus === "completed";
    kb.push([
      {
        text: isDone ? "✅ Task Done" : "Task Done",
        callback_data: "checkout_todo:done",
      },
      {
        text: !isDone ? "✅ ⏳ In Progress" : "⏳ In Progress",
        callback_data: "checkout_todo:prog",
      },
    ]);
  }

  // Project row (only if projectId exists)
  if (data.projectId) {
    const isDone = data.projectStatus === "completed";
    kb.push([
      {
        text: isDone ? "✅ 🏁 Project Done" : "🏁 Project Done",
        callback_data: "checkout_proj:done",
      },
      {
        text: !isDone ? "✅ ⏳ Keep Open" : "⏳ Keep Open",
        callback_data: "checkout_proj:prog",
      },
    ]);
  }

  // Focus row (default: casual)
  const focus = data.focus || "casual";
  kb.push([
    {
      text: focus === "focused" ? "✅ 🎯 Focused" : "🎯 Focused",
      callback_data: "checkout_focus:focused",
    },
    {
      text: focus === "casual" ? "✅ 😐 Casual" : "😐 Casual",
      callback_data: "checkout_focus:casual",
    },
    {
      text: focus === "distracted" ? "✅ 😵 Distracted" : "😵 Distracted",
      callback_data: "checkout_focus:distracted",
    },
  ]);

  // Actions row: Add Note + Done & Back to Tasks
  const noteBtnText = data.sessionNote
    ? "✏️ Edit Note"
    : data.isAddingNote
    ? "📝 Type Note in Chat"
    : "📝 Add Session Note";
  kb.push([
    { text: noteBtnText, callback_data: "checkout_note" },
    { text: "📋 Done & Back to Tasks", callback_data: "checkout_finish" },
  ]);

  return kb;
}

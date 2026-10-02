// Helper client for Telegram Bot API

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API_BASE = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

export interface BotCommand {
  command: string;
  description: string;
}

export const BOT_COMMANDS: BotCommand[] = [
  { command: "tasks", description: "Today's scheduled tasks" },
  { command: "alltasks", description: "View all tasks (all days)" },
  { command: "todo", description: "One-time to-dos with date & time" },
  { command: "log", description: "Daily diary & mood reflection" },
  { command: "today", description: "Today's scorecard & progress" },
  { command: "ask", description: "Ask AI about your data & progress" },
  { command: "doubt", description: "Log or view study/coding doubts" },
  { command: "addtask", description: "Create a new habit / routine" },
  { command: "edit", description: "Edit or delete tasks" },
];

export async function setBotCommands(commands: BotCommand[] = BOT_COMMANDS) {
  if (!TELEGRAM_TOKEN) return null;

  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands }),
    });
    return await res.json();
  } catch (err: any) {
    console.error("setBotCommands network error:", err.message);
    return null;
  }
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export type InlineKeyboard = InlineKeyboardButton[][];

export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  keyboard?: InlineKeyboard
) {
  if (!TELEGRAM_TOKEN) {
    console.warn("TELEGRAM_BOT_TOKEN is not configured.");
    return null;
  }

  const payload: any = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };

  if (keyboard && keyboard.length > 0) {
    payload.reply_markup = {
      inline_keyboard: keyboard,
    };
  }

  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (err: any) {
    console.error("sendTelegramMessage network error:", err.message);
    return null;
  }
}

export async function editTelegramMessage(
  chatId: string | number,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard
) {
  if (!TELEGRAM_TOKEN) return null;

  const payload: any = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
  };

  if (keyboard) {
    payload.reply_markup = {
      inline_keyboard: keyboard,
    };
  }

  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (err: any) {
    console.error("editTelegramMessage network error:", err.message);
    return null;
  }
}

export async function deleteTelegramMessage(chatId: string | number, messageId: number) {
  if (!TELEGRAM_TOKEN) return null;

  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
      }),
    });
    return await res.json();
  } catch (err: any) {
    console.error("deleteTelegramMessage network error:", err.message);
    return null;
  }
}

export async function removeInlineKeyboard(chatId: string | number, messageId: number) {
  if (!TELEGRAM_TOKEN) return null;

  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }),
    });
    return await res.json();
  } catch (err: any) {
    console.error("removeInlineKeyboard network error:", err.message);
    return null;
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  if (!TELEGRAM_TOKEN) return null;

  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text || "",
      }),
    });
    return await res.json();
  } catch (err: any) {
    console.error("answerCallbackQuery network error:", err.message);
    return null;
  }
}

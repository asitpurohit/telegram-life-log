/**
 * Telegram Long Polling Runner
 * Allows you to test and chat with @asit108_bot right from your Mac
 * without needing a public domain or Vercel deployment!
 */

import { POST } from "../src/app/api/webhook/route";
import { NextRequest } from "next/server";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN is missing in .env.local");
  process.exit(1);
}

console.log("=================================================");
console.log("🤖 Starting Telegram Life-Log Bot in Polling Mode");
console.log("=================================================");

async function startPolling() {
  // First, delete any existing webhook so polling can receive updates
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook`);
  console.log("✅ Webhook cleared for live local polling.");

  const meRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe`);
  const me = await meRes.json();
  console.log(`🚀 Connected as @${me.result.username} (${me.result.first_name})`);
  console.log("📲 Open Telegram on your phone and send /start to your bot!");
  console.log("Listening for messages... (Press Ctrl+C to stop)\n");

  let offset = 0;

  while (true) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=25`
      );
      const data = await res.json();

      if (data.ok && data.result && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;

          if (update.message?.text) {
            console.log(`📩 [Message from ${update.message.from?.first_name}]: "${update.message.text}"`);
          } else if (update.callback_query?.data) {
            console.log(`🔘 [Button Tapped by ${update.callback_query.from?.first_name}]: "${update.callback_query.data}"`);
          }

          // Forward to our center manager webhook handler
          const fakeReq = {
            json: async () => update,
          } as unknown as NextRequest;

          await POST(fakeReq);
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.error("Polling error (reconnecting):", err.message);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

startPolling();

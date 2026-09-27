# AI Setup Guide — Telegram Habit Tracker Bot

> **For AI assistants (ChatGPT, Claude, Gemini, Cursor…).**
> A non-technical user will hand you this file and ask you to help them set up their own
> Telegram habit tracker bot. Follow this guide step by step, in order. The user does not
> need to understand code — you will guide them, they will click/paste.

---

## Your role

1. **Guide, don't dump.** Do one step at a time. Wait for the user to confirm each step
   before moving on. Ask for screenshots if something looks off.
2. **Handle keys carefully.** The user will collect 3 secrets (Telegram token, Supabase
   service key, Gemini key). Tell them to paste each one **only into their local
   `.env.local` file**, never into a chat with you, and never commit it to git. If they
   paste one accidentally, tell them to regenerate it.
3. **Verify everything.** After setup, run the verification checklist (Step 6) before
   declaring success.
4. **Troubleshoot calmly.** Use the troubleshooting table at the end. Ask one diagnostic
   question at a time.

## Prerequisites to confirm first

- A computer (macOS / Windows / Linux) with **Node.js 18+** installed (`node -v`)
- A free **Supabase** account — https://supabase.com
- A **Telegram** account with the app installed
- A free **Google AI Studio** account (for the Gemini key) — https://aistudio.google.com
- Optional: **Vercel** account if they want the bot always online

---

## Step 1 — Create the database (Supabase)

1. Ask the user to sign in at https://supabase.com and click **New project**.
2. Suggest a name like `habit-tracker`, a strong database password (they should save it),
   and the region closest to them.
3. When the project is ready, open **SQL Editor → New query**.
4. Have them open the file **`supabase/schema.sql`** from this repository, copy its
   **entire contents**, paste into the SQL editor, and click **Run**.
5. Expected result: “Success. No rows returned”. This created the tables:
   `tasks`, `logs`, `active_timers`, `wizard_sessions`, `todos` and seeded starter tasks.
6. Collect credentials: **Project Settings → API**:
   - `Project URL` → becomes `NEXT_PUBLIC_SUPABASE_URL`
   - `service_role` secret key → becomes `SUPABASE_SERVICE_ROLE_KEY` (server-side only!)

## Step 2 — Create the Telegram bot (BotFather)

1. In Telegram, open **@BotFather** and send `/newbot`.
2. Give it a display name (e.g. `My Habit Tracker`) and a username ending in `bot`
   (e.g. `asit_habits_bot`).
3. BotFather replies with a token like `123456:ABC-DEF…` → that is `TELEGRAM_BOT_TOKEN`.
4. Optional but recommended: send `/setdescription` and `/setuserpic` to make it pretty.
5. Get the user's numeric Telegram id: open **@userinfobot**, press Start — it replies with
   their `Id` (e.g. `123456789`) → that is `ALLOWED_TELEGRAM_USER_ID`. This locks the bot
   to them so nobody else can use it.

## Step 3 — Create the Gemini key (AI features)

1. Sign in at https://aistudio.google.com/app/apikey
2. Click **Create API key** and copy it → `GEMINI_API_KEY`.
3. Note: the free tier has daily limits. If it runs out, the bot still works — diary saves
   without an AI summary and `/ask` says the AI is unavailable.

## Step 4 — Install the bot on the computer

Run these commands (guide the user; adapt paths to their OS):

```bash
git clone <repo-url> telegram-habit-tracker
cd telegram-habit-tracker
npm install
cp .env.example .env.local        # Windows: copy .env.example .env.local
```

Then have them open **`.env.local`** in any text editor and fill in the 4 values collected
above:

```env
TELEGRAM_BOT_TOKEN="…"
NEXT_PUBLIC_SUPABASE_URL="https://xxxx.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="…"
GEMINI_API_KEY="…"

APP_TIMEZONE="Asia/Kolkata"        # their timezone — important for dates & reminders
ALLOWED_TELEGRAM_USER_ID="123456789"
CRON_SECRET=""                     # only needed for the hosted option
```

## Step 5 — Verify + start

1. Run the schema check:
   ```bash
   npm run verify
   ```
   Expect ✅ for `tasks`, `logs`, `active_timers`, `wizard_sessions`, `todos`.
   If the logs/tasks table errors mention a missing column, they likely ran an old schema —
   re-run the current `supabase/schema.sql`.
2. Start the bot:
   ```bash
   npm run poll
   ```
   Expected: `✅ Webhook cleared for live local polling.` then `🚀 Connected as @your_bot`.
3. Ask the user to message their bot: `/start` → they should see the main menu.

## Step 6 — Verification checklist (do all)

| # | Action | Expected |
|---|---|---|
| 1 | `/tasks` | List shows starter tasks + 😴 Sleep |
| 2 | Create a timer task: `/addtask` → timer → name → goal `45 mins` → reminder time → days | Task created screen |
| 3 | Start it, wait ~1 min, stop | “Session Completed”, today's total updated |
| 4 | `/today` | Scorecard with habits + `🕳️ Wasted:` line |
| 5 | `/todo` → add a todo 2 minutes ahead | Reminder arrives at that minute (needs `npm run poll` running) |
| 6 | `/log` → write a diary line | AI summary + any task notes attached |
| 7 | `/ask how much time did I waste today` | AI answer using real data |

If 5 fails but others pass, the polling process isn't running or was stopped.

## Step 7 (optional) — Keep it always online with Vercel

Only needed if they want the bot running when their computer is off.

1. Push the folder to **their own** GitHub repo (the `.env.local` file is gitignored — good).
2. On https://vercel.com → **Add New → Project** → import that repo.
3. Add the same environment variables (Project → Settings → Environment Variables).
4. Deploy, then register the webhook (replace token & domain):
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<app>.vercel.app/api/webhook"
   ```
5. Set up a **1-minute cron** (Vercel Hobby crons only run once a day — use
   [cron-job.org](https://cron-job.org) or GitHub Actions) hitting:
   ```
   https://<app>.vercel.app/api/tick?key=<CRON_SECRET>
   ```
   Set `CRON_SECRET` in Vercel env vars first.
6. **Stop `npm run poll` on the computer** — Telegram allows either webhook or polling,
   never both. Running polling deletes the webhook (and vice-versa), which is the usual
   cause of “the bot stopped responding”.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot silent after it worked before | webhook/polling conflict — two runners fighting | Run only ONE: either `npm run poll` **or** webhook + cron |
| `/start` replies nothing at all | wrong `TELEGRAM_BOT_TOKEN`, or bot blocked | Re-copy token from BotFather; unblock bot |
| “Access Denied” reply | `ALLOWED_TELEGRAM_USER_ID` doesn't match | Send the correct numeric id from @userinfobot |
| Reminders never arrive | `/api/tick` not being called (or CRON_SECRET mismatch) | Check the cron URL returns `{"status":"ok",…}`; keep `npm run poll` running for local use |
| No AI summaries / “AI unavailable” | Gemini quota/key | New key or wait for quota reset; bot still works without AI |
| Wrong dates/reminder times | wrong `APP_TIMEZONE` | Set correct IANA timezone (e.g. `Europe/Berlin`), restart |
| `column … does not exist` errors | old database schema | Re-run the current `supabase/schema.sql` in SQL Editor |
| Timer message not updating every 5s | local polling stopped | Restart `npm run poll` (session data is safe either way) |

## Security notes (tell the user)

- `.env.local` is gitignored — **never** commit it or share the `service_role` key.
- The service key bypasses row-level security; it lives only on their machine/Vercel env.
- Revoking access is easy: regenerate keys in BotFather/Supabase/AI Studio anytime.

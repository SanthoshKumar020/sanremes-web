# SanRemes Telegram bridge

Chat with your SanRemes bot from Telegram. The bot lives on your laptop;
this bridge (on Vercel) connects Telegram's Bot API to it.

Live webhook: `https://sanremes-web.vercel.app/api/telegram/webhook`

## How a message flows

```
you (Telegram) → Telegram → Vercel bridge
  → Cloudflare tunnel → SanRemes on your laptop (Bot API, :8800)
  → bot replies → bridge → Telegram Bot API → you
```

The laptop side uses SanRemes' own Bot API (`POST
/hooks/api/bots/<botId>/messages`, bearer key, `wait` up to 300s). The
bridge waits 45s for the reply, polls the thread once more if it is still
working, then answers you on Telegram. Long replies are split into
under-4000-character messages. If the bot stops at an approval, the bridge
tells you to approve it in the desktop app — approvals are answered in the
app, not in Telegram.

## What it can and cannot do

- Chat with your bot, including its Browser surface (Groq handles that).
- Tell you when an approval is waiting, and when the bot is busy.
- It cannot do full PC control: your bot runs on free Groq gpt-oss-120b,
  which cannot use the computer. That needs the bot's brain switched to
  Claude (paid).
- The bot only answers while SanRemes is running on your laptop and the
  tunnel is up. It only answers the chat IDs in
  `TELEGRAM_ALLOWED_CHAT_IDS`.
- Only text messages are forwarded for now. Photos and voice notes get a
  short reply saying text only.

## Setup — the parts that need you

### 1. Telegram: create the bot (2 minutes, on your phone)

1. Open Telegram and search for **@BotFather**.
2. Send `/newbot`, pick a display name (e.g. `SanRemes`) and a username
   ending in `bot` (e.g. `sanremes_bot`).
3. BotFather replies with a **token** like `123456:ABC-DEF...`. Copy it —
   it is shown once, and it is the bot's password. Never post it anywhere
   public.
4. Send the token to Muse through the secure card (not in chat) so it can
   be saved for the bridge.

### 2. Laptop: turn on the Bot API (5 minutes, in the desktop app)

Same steps as the WhatsApp bridge — if you already did this for WhatsApp,
skip it:

1. Open SanRemes on your laptop. Open your main bot's settings → Bot API.
2. Switch it **on** and mint a **new key**. Copy the key — it is shown once.
3. Turn **acts-as-owner on**. This is what lets the bot act for you from
   Telegram instead of treating every message as outside work. Only the
   owner can switch this on.
4. The app shows the Bot API endpoint, like
   `http://127.0.0.1:8800/hooks/api/bots/<botId>/messages`. Note the bot id.

### 3. Laptop: expose the webhook receiver (Cloudflare tunnel)

Same as the WhatsApp bridge — if the tunnel is already running for
WhatsApp, reuse it:

1. Install `cloudflared` on the laptop.
2. Run `cloudflared tunnel --url http://127.0.0.1:8800` and keep it running.
   It prints a public URL like `https://something.trycloudflare.com`.
3. Your Bot API URL is that public URL plus the path from step 2:
   `https://something.trycloudflare.com/hooks/api/bots/<botId>/messages`.

The quick-tunnel URL changes every time cloudflared restarts. When it
changes, update the `SANREMES_BOT_API_URL` variable below and redeploy.
(A named tunnel with a fixed hostname is the later fix; it needs a
Cloudflare account and a domain.)

### 4. Vercel: environment variables (sanremes-web project, Production)

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the token from BotFather (step 1.3) |
| `TELEGRAM_WEBHOOK_SECRET` | any random string you pick — the bridge rejects updates without it |
| `TELEGRAM_ALLOWED_CHAT_IDS` | the Telegram chat ID(s) allowed to talk to the bot, comma-separated |
| `SANREMES_BOT_API_URL` | the tunnel URL + `/hooks/api/bots/<botId>/messages` from steps 2–3 |
| `SANREMES_BOT_API_KEY` | the Bot API key from step 2.2 |

`SANREMES_BOT_API_URL` and `SANREMES_BOT_API_KEY` are shared with the
WhatsApp bridge — if they are already set, do not change them.

After setting them, redeploy the project (`npx vercel --prod --yes`).

**Finding your chat ID:** message the bot once. If your chat ID is not in
`TELEGRAM_ALLOWED_CHAT_IDS` yet, the bot replies with your chat ID. Add
that number to the variable and redeploy.

### 5. Telegram: register the webhook (one link)

After the Vercel variables are set and the app is redeployed, open this
link in your browser (replace the two placeholders):

```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://sanremes-web.vercel.app/api/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

A reply of `{"ok":true,...}` means Telegram will now send your messages to
the bridge. To check the webhook status later, open
`https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo`.

## Testing

1. With SanRemes running and the tunnel up, send the bot a Telegram
   message: `hi, what can you do?`
2. You should get the bot's reply within a minute.
3. If nothing comes back, check in order: Vercel deployment logs (bridge
   errors), the tunnel is still running and the URL matches
   `SANREMES_BOT_API_URL`, SanRemes is running, the Bot API is on and the
   key matches, the webhook is registered (`getWebhookInfo` shows the
   right URL and no recent errors).

## Notes and limits

- Keep this 1:1 and personal. This bridge is a private control channel
  for your own bot, not a public assistant.
- The bridge never logs message text or chat IDs, only counts.
- The bridge's own wait is 45s (Vercel's function limit is 60s). Most
  Groq turns answer in seconds. A turn that runs longer gets one extra
  poll; if it is still working, the bridge says so and the answer lands in
  the SanRemes thread on your laptop.
- Rate limit: the Bot API key takes 10 calls a minute.
- The companion phone-connect UI in the app stays as it is. Remove it only
  after this route has worked for a while.

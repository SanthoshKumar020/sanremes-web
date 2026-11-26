# SanRemes WhatsApp bridge

Chat with your SanRemes bot from WhatsApp. The bot lives on your laptop;
this bridge (on Vercel) connects Meta's WhatsApp Cloud API to it.

Live webhook: `https://sanremes-web.vercel.app/api/whatsapp/webhook`

## How a message flows

```
you (from your second number) → WhatsApp → Vercel bridge
  → Cloudflare tunnel → SanRemes on your laptop (Bot API, :8800)
  → bot replies → bridge → WhatsApp Cloud API → you
```

The laptop side uses SanRemes' own Bot API (`POST
/hooks/api/bots/<botId>/messages`, bearer key, `wait` up to 300s). The
bridge waits 45s for the reply, polls the thread once more if it is still
working, then answers you on WhatsApp. Long replies are split into
under-4000-character messages. If the bot stops at an approval, the bridge
tells you to approve it in the desktop app — approvals are answered in the
app, not in WhatsApp.

## What it can and cannot do

- Chat with your bot, including its Browser surface (Groq handles that).
- Tell you when an approval is waiting, and when the bot is busy.
- It cannot do full PC control: your bot runs on free Groq gpt-oss-120b,
  which cannot use the computer. That needs the bot's brain switched to
  Claude (paid).
- The bot only answers while SanRemes is running on your laptop and the
  tunnel is up. It only answers the numbers in `WHATSAPP_ALLOWED_SENDERS`.
- Replies only work inside the 24-hour window that opens when you message
  the bot first. That is always true for your own use.

## Setup — the parts that need you

### 1. Laptop: turn on the Bot API (5 minutes, in the desktop app)

1. Open SanRemes on your laptop. Open your main bot's settings → Bot API.
2. Switch it **on** and mint a **new key**. Copy the key — it is shown once.
3. Turn **acts-as-owner on**. This is what lets the bot act for you from
   WhatsApp instead of treating every message as outside work. Only the
   owner can switch this on.
4. The app shows the Bot API endpoint, like
   `http://127.0.0.1:8800/hooks/api/bots/<botId>/messages`. Note the bot id.

### 2. Laptop: expose the webhook receiver (Cloudflare tunnel)

The SanRemes server also runs a webhook receiver on port 8800
(`SANREMES_WEBHOOK_PORT`, or app port + 1). It is localhost-only, so put a
tunnel in front of it:

1. Install `cloudflared` on the laptop.
2. Run `cloudflared tunnel --url http://127.0.0.1:8800` and keep it running.
   It prints a public URL like `https://something.trycloudflare.com`.
3. Your Bot API URL is that public URL plus the path from step 1:
   `https://something.trycloudflare.com/hooks/api/bots/<botId>/messages`.

The quick-tunnel URL changes every time cloudflared restarts. When it
changes, update the `SANREMES_BOT_API_URL` variable below and redeploy.
(A named tunnel with a fixed hostname is the later fix; it needs a
Cloudflare account and a domain.)

Optional: set `SANREMES_WEBHOOK_PUBLIC_URL` to the tunnel URL before
starting SanRemes, so the app itself shows the public endpoint. Without it
the app shows the localhost address — you can still build the URL by hand.

### 3. Meta: app, number, token, webhook (needs your phone)

1. Go to developers.facebook.com → **Create App** (type Business) → add
   the **WhatsApp** product.
2. **Migrate your number.** In WhatsApp Manager → Phone numbers → Add
   phone number → enter **+91 63743 10315**. Meta sends an OTP by SMS or
   voice call to that number. Once migrated, **6374310315 stops working in
   the WhatsApp app** — it becomes the bot's number. This is the step you
   chose; it cannot be undone by just reinstalling WhatsApp.
3. **Permanent token.** Temporary tokens expire in about a day, so do not
   use one. In Business Settings → **System Users** → create a system user
   → give it the WhatsApp app → generate a token with
   `whatsapp_business_messaging` and `whatsapp_business_management`.
   Copy it — it is shown once.
4. **Phone number ID.** In the app dashboard → WhatsApp → API Setup, copy
   the **Phone number ID** for 6374310315 (a long number, not the phone
   number itself).
5. **Webhook.** In the app dashboard → WhatsApp → Configuration → Webhook:
   - Callback URL: `https://sanremes-web.vercel.app/api/whatsapp/webhook`
   - Verify token: pick any random string, for example from a password
     generator. You will paste the same string into Vercel below.
   - Subscribe to the **messages** field.
   - Meta calls the URL to verify it. It only passes once the Vercel
     variables below are set and the app is redeployed.

### 4. Vercel: environment variables (sanremes-web project, Production)

| Variable | Value |
|---|---|
| `WHATSAPP_VERIFY_TOKEN` | the verify-token string from step 3.5 |
| `WHATSAPP_APP_SECRET` | App Dashboard → Settings → Basic → App Secret |
| `WHATSAPP_ACCESS_TOKEN` | the permanent system-user token from step 3.3 |
| `WHATSAPP_PHONE_NUMBER_ID` | the phone number ID from step 3.4 |
| `WHATSAPP_ALLOWED_SENDERS` | the number(s) you will chat **from**, comma-separated, e.g. `919876543210` |
| `SANREMES_BOT_API_URL` | the tunnel URL + `/hooks/api/bots/<botId>/messages` from steps 1–2 |
| `SANREMES_BOT_API_KEY` | the Bot API key from step 1.2 |

After setting them, redeploy the project (`npx vercel --prod --yes`).

**Which number do you chat from?** The bot lives on 6374310315, so you
cannot message it from that same number. Chat with it from a second
WhatsApp number — another SIM, or a family member's phone — and put that
number in `WHATSAPP_ALLOWED_SENDERS`. Any other sender is ignored.

## Testing

1. With SanRemes running and the tunnel up, send the bot a WhatsApp
   message from an allowlisted number: `hi, what can you do?`
2. You should get the bot's reply within a minute.
3. If nothing comes back, check in order: Vercel deployment logs (bridge
   errors), the tunnel is still running and the URL matches
   `SANREMES_BOT_API_URL`, SanRemes is running, the Bot API is on and the
   key matches.

## Notes and limits

- Keep this 1:1 and personal. Meta restricts general-purpose AI assistant
  bots on WhatsApp; this bridge is a private control channel for your own
  bot, not a public assistant.
- The bridge never logs message text or phone numbers, only counts.
- The bridge's own wait is 45s (Vercel's function limit is 60s). Most
  Groq turns answer in seconds. A turn that runs longer gets one extra
  poll; if it is still working, the bridge says so and the answer lands in
  the SanRemes thread on your laptop.
- Rate limit: the Bot API key takes 10 calls a minute.
- The companion phone-connect UI in the app stays as it is. Remove it only
  after this route has worked for a while.

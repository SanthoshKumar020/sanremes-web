import { after, NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

const TELEGRAM_API = "https://api.telegram.org";
const BOT_API_WAIT_SECONDS = 45;
const MAX_TEXT_CHARS = 4000;

type TelegramMessage = {
  message_id?: unknown;
  from?: { id?: unknown; username?: unknown };
  chat?: { id?: unknown; type?: unknown };
  text?: unknown;
};

type TelegramUpdate = {
  update_id?: unknown;
  message?: TelegramMessage;
};

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function allowedChatIds(): Set<string> {
  return new Set(
    env("TELEGRAM_ALLOWED_CHAT_IDS")
      .split(",")
      .map((entry) => entry.replace(/[^\d-]/g, ""))
      .filter(Boolean),
  );
}

function verifySecretToken(header: string | null): boolean {
  const secret = env("TELEGRAM_WEBHOOK_SECRET");
  if (!secret) return false;
  return header === secret;
}

async function sendTelegram(chatId: string, text: string): Promise<boolean> {
  const token = env("TELEGRAM_BOT_TOKEN");
  if (!token) return false;
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function chunkText(text: string): string[] {
  if (text.length <= MAX_TEXT_CHARS) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX_TEXT_CHARS) {
    let cut = rest.lastIndexOf("\n\n", MAX_TEXT_CHARS);
    if (cut < 1000) cut = rest.lastIndexOf("\n", MAX_TEXT_CHARS);
    if (cut < 1000) cut = MAX_TEXT_CHARS;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendReply(chatId: string, text: string): Promise<void> {
  for (const chunk of chunkText(text)) {
    await sendTelegram(chatId, chunk);
  }
}

type BotApiAnswer =
  | { reply: string; thread: string }
  | { thread: string; status: "working" | "needs_approval" };

async function callBotApi(
  url: string,
  key: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ status: number; data: BotApiAnswer | { error?: string } | null }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json().catch(() => null)) as BotApiAnswer | {
      error?: string;
    } | null;
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

async function pollThread(
  url: string,
  key: string,
  thread: string,
): Promise<BotApiAnswer | { error?: string } | null> {
  try {
    const res = await fetch(
      `${url.split("?")[0]}?thread=${encodeURIComponent(thread)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10000),
      },
    );
    return (await res.json().catch(() => null)) as BotApiAnswer | {
      error?: string;
    } | null;
  } catch {
    return null;
  }
}

async function handleTextMessage(chatId: string, text: string): Promise<void> {
  const botApiUrl = env("SANREMES_BOT_API_URL");
  const botApiKey = env("SANREMES_BOT_API_KEY");
  if (!botApiUrl || !botApiKey) {
    await sendReply(
      chatId,
      "The Telegram bridge isn't connected to your laptop yet. Finish the setup and try again.",
    );
    return;
  }

  const thread = `tg-${chatId}`;
  const first = await callBotApi(
    botApiUrl,
    botApiKey,
    { message: text.slice(0, 4096), thread, wait: BOT_API_WAIT_SECONDS },
    52000,
  );

  if (first.status === 200 && first.data && "reply" in first.data) {
    await sendReply(chatId, first.data.reply || "Done.");
    return;
  }

  if (first.status === 202 && first.data && "status" in first.data) {
    if (first.data.status === "needs_approval") {
      await sendReply(
        chatId,
        "That needs your approval. Open SanRemes on your laptop and approve it in the thread, then message me again.",
      );
      return;
    }
    const second = await pollThread(botApiUrl, botApiKey, thread);
    if (second && "reply" in second) {
      await sendReply(chatId, second.reply || "Done.");
      return;
    }
    if (second && "status" in second && second.status === "needs_approval") {
      await sendReply(
        chatId,
        "That needs your approval. Open SanRemes on your laptop and approve it in the thread, then message me again.",
      );
      return;
    }
    await sendReply(
      chatId,
      "Still working on it — the answer will be in the SanRemes thread on your laptop. Ask me again in a minute if it's not there.",
    );
    return;
  }

  if (first.status === 409 || first.status === 429) {
    await sendReply(chatId, "The bot is busy right now. Try again in a moment.");
    return;
  }

  await sendReply(
    chatId,
    "The bot couldn't answer that. Open the thread in SanRemes on your laptop to see why.",
  );
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "sanremes-telegram-bridge" });
}

export async function POST(req: NextRequest) {
  if (!verifySecretToken(req.headers.get("x-telegram-bot-api-secret-token"))) {
    return NextResponse.json({ error: "Bad secret token." }, { status: 403 });
  }

  let payload: unknown = null;
  try {
    payload = (await req.json()) as unknown;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const message = (payload as TelegramUpdate)?.message;
  const chatId =
    message?.chat?.id !== undefined ? String(message.chat.id) : "";
  const text = typeof message?.text === "string" ? message.text.trim() : "";

  after(async () => {
    if (!chatId || !text) return;
    const allowed = allowedChatIds();
    if (!allowed.has(chatId)) {
      if (allowed.size === 0) {
        await sendReply(
          chatId,
          `This bot isn't set up for your chat yet. Your Telegram chat ID is ${chatId} — add it to TELEGRAM_ALLOWED_CHAT_IDS in the bridge settings, then message me again.`,
        );
      }
      return;
    }
    await handleTextMessage(chatId, text);
  });

  return NextResponse.json({ ok: true });
}

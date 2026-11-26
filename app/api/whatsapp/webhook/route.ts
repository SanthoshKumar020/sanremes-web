import { createHmac, timingSafeEqual } from "node:crypto";
import { after, NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

const GRAPH_VERSION = "v27.0";
const BOT_API_WAIT_SECONDS = 45;
const MAX_TEXT_CHARS = 4000;

type WhatsappMessage = {
  from?: unknown;
  id?: unknown;
  type?: unknown;
  text?: { body?: unknown };
};

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function normalizeNumber(value: string): string {
  return value.replace(/[^\d]/g, "");
}

function allowedSenders(): Set<string> {
  return new Set(
    env("WHATSAPP_ALLOWED_SENDERS")
      .split(",")
      .map((entry) => normalizeNumber(entry))
      .filter(Boolean),
  );
}

function verifySignature(rawBody: string, signature: string | null): boolean {
  const secret = env("WHATSAPP_APP_SECRET");
  if (!secret || !signature) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function sendWhatsapp(to: string, body: string): Promise<boolean> {
  const token = env("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = env("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneNumberId) return false;
  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { preview_url: false, body },
        }),
      },
    );
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

async function sendReply(to: string, text: string): Promise<void> {
  for (const chunk of chunkText(text)) {
    await sendWhatsapp(to, chunk);
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

async function handleTextMessage(from: string, text: string): Promise<void> {
  const botApiUrl = env("SANREMES_BOT_API_URL");
  const botApiKey = env("SANREMES_BOT_API_KEY");
  if (!botApiUrl || !botApiKey) {
    await sendReply(
      from,
      "The WhatsApp bridge isn't connected to your laptop yet. Finish the setup and try again.",
    );
    return;
  }

  const thread = `wa-${normalizeNumber(from)}`;
  const first = await callBotApi(
    botApiUrl,
    botApiKey,
    { message: text.slice(0, 4096), thread, wait: BOT_API_WAIT_SECONDS },
    52000,
  );

  if (first.status === 200 && first.data && "reply" in first.data) {
    await sendReply(from, first.data.reply || "Done.");
    return;
  }

  if (first.status === 202 && first.data && "status" in first.data) {
    if (first.data.status === "needs_approval") {
      await sendReply(
        from,
        "That needs your approval. Open SanRemes on your laptop and approve it in the thread, then message me again.",
      );
      return;
    }
    const second = await pollThread(botApiUrl, botApiKey, thread);
    if (second && "reply" in second) {
      await sendReply(from, second.reply || "Done.");
      return;
    }
    if (second && "status" in second && second.status === "needs_approval") {
      await sendReply(
        from,
        "That needs your approval. Open SanRemes on your laptop and approve it in the thread, then message me again.",
      );
      return;
    }
    await sendReply(
      from,
      "Still working on it — the answer will be in the SanRemes thread on your laptop. Ask me again in a minute if it's not there.",
    );
    return;
  }

  if (first.status === 409 || first.status === 429) {
    await sendReply(from, "The bot is busy right now. Try again in a moment.");
    return;
  }

  await sendReply(
    from,
    "The bot couldn't answer that. Open the thread in SanRemes on your laptop to see why.",
  );
}

function extractMessages(payload: unknown): WhatsappMessage[] {
  const out: WhatsappMessage[] = [];
  if (!payload || typeof payload !== "object") return out;
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: unknown }).value;
      if (!value || typeof value !== "object") continue;
      const messages = (value as { messages?: unknown }).messages;
      if (!Array.isArray(messages)) continue;
      for (const message of messages) {
        if (message && typeof message === "object") {
          out.push(message as WhatsappMessage);
        }
      }
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode && token && challenge) {
    if (mode === "subscribe" && token === env("WHATSAPP_VERIFY_TOKEN")) {
      return new Response(challenge, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }
    return NextResponse.json({ error: "Verification failed." }, { status: 403 });
  }

  return NextResponse.json({ ok: true, service: "sanremes-whatsapp-bridge" });
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  if (!verifySignature(rawBody, signature)) {
    return NextResponse.json({ error: "Bad signature." }, { status: 403 });
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const messages = extractMessages(payload);
  const senders = allowedSenders();

  after(async () => {
    for (const message of messages) {
      const from = typeof message.from === "string" ? message.from : "";
      if (!from || !senders.has(normalizeNumber(from))) continue;
      if (message.type !== "text") {
        await sendReply(from, "Send text for now — I can't read photos or voice notes yet.");
        continue;
      }
      const body =
        typeof message.text?.body === "string" ? message.text.body.trim() : "";
      if (!body) continue;
      await handleTextMessage(from, body);
    }
  });

  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { getRole } from "@/lib/roles";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "openai/gpt-oss-120b";

type IncomingMessage = { role: "user" | "assistant"; content: string };

function isIncomingMessage(value: unknown): value is IncomingMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    (m.role === "user" || m.role === "assistant") &&
    typeof m.content === "string"
  );
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { role, messages, stream } = body as {
    role?: unknown;
    messages?: unknown;
    stream?: unknown;
  };

  if (typeof role !== "string" || role.length === 0) {
    return NextResponse.json({ error: "Missing role." }, { status: 400 });
  }

  const roleDef = getRole(role);
  if (!roleDef) {
    return NextResponse.json(
      { error: `Unknown role: ${role}` },
      { status: 400 }
    );
  }

  if (!Array.isArray(messages)) {
    return NextResponse.json(
      { error: "messages must be an array." },
      { status: 400 }
    );
  }

  const clean: IncomingMessage[] = messages
    .filter(isIncomingMessage)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 12000) }))
    .slice(-30);

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "The server API key is not configured. Set GROQ_API_KEY on the server to enable chat.",
      },
      { status: 500 }
    );
  }

  const useStream = stream !== false;

  let upstream: Response;
  try {
    upstream = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.7,
        max_tokens: 2048,
        stream: useStream,
        messages: [
          { role: "system", content: roleDef.systemPrompt },
          ...clean,
        ],
      }),
    });
  } catch {
    return NextResponse.json(
      { error: "Could not reach the AI service. Please try again." },
      { status: 502 }
    );
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    let message = `AI service returned ${upstream.status}.`;
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string };
      };
      if (parsed?.error?.message) message = parsed.error.message;
    } catch {
      if (text) message = text.slice(0, 500);
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }

  if (!useStream) {
    const data = (await upstream.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>;
    } | null;
    const reply = data?.choices?.[0]?.message?.content ?? "";
    return NextResponse.json({ reply });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const upstreamBody = upstream.body;

  const readable = new ReadableStream({
    async start(controller) {
      const reader = upstreamBody?.getReader();
      if (!reader) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const json = JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const delta = json?.choices?.[0]?.delta?.content ?? "";
              if (delta) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ content: delta })}\n\n`
                  )
                );
              }
            } catch {
              // Skip partial chunks; the next chunk completes the line.
            }
          }
        }
      } catch {
        // Client disconnected or upstream stream broke; end cleanly.
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

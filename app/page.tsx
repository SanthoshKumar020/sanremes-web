"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface RoleInfo {
  id: string;
  name: string;
  tagline: string;
  description: string;
  initials: string;
  color: string;
  suggestions: string[];
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const STORAGE_KEY = "sanremes-chats-v1";
const KEY_STORAGE = "sanremes-groq-key";
const DEFAULT_ROLE_ID = "data-engineer";

function loadChats(): Record<string, ChatMessage[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, ChatMessage[]> = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>
    )) {
      if (!Array.isArray(value)) continue;
      out[key] = value.filter(
        (m): m is ChatMessage =>
          !!m &&
          typeof m === "object" &&
          (m as ChatMessage).role !== undefined &&
          ((m as ChatMessage).role === "user" ||
            (m as ChatMessage).role === "assistant") &&
          typeof (m as ChatMessage).content === "string"
      );
    }
    return out;
  } catch {
    return {};
  }
}

/* ---------- Markdown components ---------- */

function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const text = preRef.current?.innerText ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context); do nothing.
    }
  };

  return (
    <div className="relative my-3 overflow-hidden rounded-xl bg-[#232220]">
      <button
        type="button"
        onClick={copy}
        className="absolute right-2 top-2 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] font-medium text-white/80 transition hover:bg-white/10"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre
        ref={preRef}
        className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed text-[#f5f2ea]"
      >
        {props.children}
      </pre>
    </div>
  );
}

function InlineCode(props: React.HTMLAttributes<HTMLElement>) {
  return (
    <code className="rounded-md bg-[#eceae5] px-1.5 py-0.5 font-mono text-[0.85em] text-[#1f1e1c]">
      {props.children}
    </code>
  );
}

function MdLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...props}
      target="_blank"
      rel="noreferrer"
      className="text-[#1d4ed8] underline underline-offset-2"
    />
  );
}

const mdComponents: Components = {
  pre: CodeBlock,
  code: InlineCode,
  a: MdLink,
};

/* ---------- Page ---------- */

export default function Home() {
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [activeRoleId, setActiveRoleId] = useState<string>(DEFAULT_ROLE_ID);
  const [chats, setChats] = useState<Record<string, ChatMessage[]>>({});
  const [hydrated, setHydrated] = useState(false);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [keyJustSaved, setKeyJustSaved] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const activeRole: RoleInfo | undefined =
    roles.find((r) => r.id === activeRoleId) ?? roles[0];
  const messages: ChatMessage[] = activeRole
    ? (chats[activeRole.id] ?? [])
    : [];

  // Load roles from the server.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/roles")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load roles (${res.status})`);
        const data = (await res.json()) as { roles: RoleInfo[] };
        if (!cancelled) setRoles(data.roles ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setRolesError(
            err instanceof Error ? err.message : "Could not load roles."
          );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load saved chats + API key from localStorage after mount (avoids hydration mismatch).
  useEffect(() => {
    setChats(loadChats());
    try {
      setApiKey(localStorage.getItem(KEY_STORAGE) ?? "");
    } catch {
      // Storage unavailable; chat falls back to the server key.
    }
    setHydrated(true);
  }, []);

  // Persist chats per role.
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
    } catch {
      // Storage full or unavailable; chats simply won't persist.
    }
  }, [chats, hydrated]);

  // Keep the active role valid once roles load.
  useEffect(() => {
    if (roles.length > 0 && !roles.some((r) => r.id === activeRoleId)) {
      setActiveRoleId(roles[0].id);
    }
  }, [roles, activeRoleId]);

  // Auto-scroll to the bottom on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isStreaming, activeRoleId]);

  // Auto-grow the composer.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  const selectRole = (id: string) => {
    setActiveRoleId(id);
    setSidebarOpen(false);
  };

  const newChat = () => {
    if (!activeRole) return;
    const id = activeRole.id;
    setChats((prev) => ({ ...prev, [id]: [] }));
    setSidebarOpen(false);
  };

  const saveApiKey = () => {
    const value = keyInput.trim();
    if (!value) return;
    try {
      localStorage.setItem(KEY_STORAGE, value);
    } catch {
      // Storage unavailable; keep the key for this session only.
    }
    setApiKey(value);
    setKeyInput("");
    setKeyJustSaved(true);
    setTimeout(() => setKeyJustSaved(false), 2500);
  };

  const removeApiKey = () => {
    try {
      localStorage.removeItem(KEY_STORAGE);
    } catch {
      // Nothing to clean up.
    }
    setApiKey("");
    setKeyJustSaved(false);
  };

  const stopStreaming = () => {
    abortRef.current?.abort();
  };

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming || !activeRole) return;
    const roleId = activeRole.id;
    const history: ChatMessage[] = chats[roleId] ?? [];
    const nextHistory: ChatMessage[] = [
      ...history,
      { role: "user", content: trimmed },
    ];
    setChats((prev) => ({ ...prev, [roleId]: nextHistory }));
    setInput("");
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: roleId,
          messages: nextHistory,
          stream: true,
          ...(apiKey ? { apiKey } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      if (!res.body) throw new Error("No response stream received.");

      // Seed an empty assistant message, then grow it as tokens arrive.
      setChats((prev) => ({
        ...prev,
        [roleId]: [
          ...(prev[roleId] ?? nextHistory),
          { role: "assistant", content: "" },
        ],
      }));

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (payload === "[DONE]") break;
          try {
            const json = JSON.parse(payload) as { content?: string };
            const delta = json.content ?? "";
            if (delta) {
              assistantText += delta;
              const snap = assistantText;
              setChats((prev) => {
                const msgs = [...(prev[roleId] ?? [])];
                const last = msgs[msgs.length - 1];
                if (last?.role === "assistant") {
                  msgs[msgs.length - 1] = {
                    role: "assistant",
                    content: snap,
                  };
                }
                return { ...prev, [roleId]: msgs };
              });
            }
          } catch {
            // Partial line; the next chunk completes it.
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // User stopped it; keep whatever arrived.
      } else {
        let msg = err instanceof Error ? err.message : "Something went wrong.";
        if (msg.toLowerCase().includes("invalid api key")) {
          msg =
            "The server's API key is not working. Add your own free Groq key in the sidebar (it stays in your browser) and try again.";
        }
        setChats((prev) => {
          const msgs = [...(prev[roleId] ?? [])];
          const last = msgs[msgs.length - 1];
          if (last?.role === "assistant" && last.content === "") {
            msgs[msgs.length - 1] = {
              role: "assistant",
              content: `Sorry, something went wrong: ${msg}`,
            };
          } else {
            msgs.push({
              role: "assistant",
              content: `Sorry, something went wrong: ${msg}`,
            });
          }
          return { ...prev, [roleId]: msgs };
        });
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  };

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage(input);
    }
  };

  const lastAssistantEmpty =
    messages.length > 0 &&
    messages[messages.length - 1].role === "assistant" &&
    messages[messages.length - 1].content === "";

  return (
    <div className="flex h-dvh overflow-hidden bg-[#faf9f7] text-[#1f1e1c]">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-[#e6e3dd] bg-[#f4f3f0] transition-transform duration-200 lg:static lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="px-4 pb-3 pt-5">
          <div className="flex items-center gap-2.5 px-1">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1f1e1c] text-sm font-bold text-white">
              S
            </div>
            <div>
              <div className="text-[17px] font-bold leading-tight tracking-tight">
                SanRemes
              </div>
              <div className="text-xs text-[#6f6d68]">
                Role-based AI assistants
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={newChat}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-full border border-[#e6e3dd] bg-white px-4 py-2.5 text-sm font-medium shadow-sm transition hover:bg-[#faf9f7]"
          >
            <span aria-hidden="true" className="text-base leading-none">
              +
            </span>
            New chat
          </button>
        </div>

        <div className="px-6 pt-1 text-[11px] font-semibold uppercase tracking-wider text-[#6f6d68]">
          Roles
        </div>
        <nav className="mt-1 flex-1 overflow-y-auto px-3 pb-4">
          {rolesError && (
            <p className="px-3 py-2 text-sm text-[#b3261e]">{rolesError}</p>
          )}
          {roles.length === 0 && !rolesError && (
            <p className="px-3 py-2 text-sm text-[#6f6d68]">
              Loading roles…
            </p>
          )}
          {roles.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => selectRole(r.id)}
              className={`mt-1 flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                r.id === activeRole?.id
                  ? "bg-white shadow-sm ring-1 ring-[#e6e3dd]"
                  : "hover:bg-[#eceae5]"
              }`}
            >
              <span
                className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-white"
                style={{ backgroundColor: r.color }}
              >
                {r.initials}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">
                  {r.name}
                </span>
                <span className="block truncate text-xs text-[#6f6d68]">
                  {r.tagline}
                </span>
              </span>
            </button>
          ))}
        </nav>

        <div className="px-3 pb-2">
          <a
            href="/auto-de"
            className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-[#eceae5]"
          >
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#57534e] text-[12px] font-bold text-white">
              DE
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">
                Auto-DE Studio
              </span>
              <span className="block truncate text-xs text-[#6f6d68]">
                Clean &amp; transform CSVs
              </span>
            </span>
          </a>
          <a
            href="/build"
            className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-[#eceae5]"
          >
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#0369a1] text-[12px] font-bold text-white">
              WB
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">
                Website Builder
              </span>
              <span className="block truncate text-xs text-[#6f6d68]">
                Brief → build → test → live link
              </span>
            </span>
          </a>
        </div>

        <div className="border-t border-[#e6e3dd] px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#6f6d68]">
            Groq API key
          </div>
          {apiKey ? (
            <div className="mt-2">
              <p className="text-xs leading-relaxed text-[#6f6d68]">
                <span className="inline-block h-2 w-2 rounded-full bg-green-600 align-middle" />{" "}
                Key saved in this browser
                <span className="font-mono"> (…{apiKey.slice(-4)})</span>
              </p>
              <button
                type="button"
                onClick={removeApiKey}
                className="mt-2 rounded-full border border-[#e6e3dd] bg-white px-3 py-1.5 text-xs font-medium transition hover:bg-[#faf9f7]"
              >
                Remove key
              </button>
            </div>
          ) : (
            <div className="mt-2 flex gap-2">
              <input
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveApiKey();
                }}
                placeholder="gsk_…"
                aria-label="Groq API key"
                className="min-w-0 flex-1 rounded-lg border border-[#e6e3dd] bg-white px-3 py-2 font-mono text-xs outline-none placeholder:text-[#9a978f] focus:ring-2 focus:ring-[#1f1e1c]/10"
              />
              <button
                type="button"
                onClick={saveApiKey}
                disabled={!keyInput.trim()}
                className="shrink-0 rounded-lg bg-[#1f1e1c] px-3 py-2 text-xs font-medium text-white transition hover:bg-black disabled:opacity-30"
              >
                Save
              </button>
            </div>
          )}
          {keyJustSaved && (
            <p className="mt-2 text-xs font-medium text-green-700">
              Key saved. You can chat now.
            </p>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-[#9a978f]">
            Your key stays in this browser only — it is sent with each chat
            request and never stored on the server. Get a free key at{" "}
            <a
              href="https://console.groq.com/keys"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              console.groq.com
            </a>
            .
          </p>
        </div>

        <div className="border-t border-[#e6e3dd] px-4 py-3 text-[11px] leading-relaxed text-[#6f6d68]">
          Pick a role, then chat. Each role keeps its own conversation on this
          device.
        </div>
      </aside>

      {/* Main column */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-[#e6e3dd] bg-[#faf9f7] px-4 py-3">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#e6e3dd] bg-white text-[#1f1e1c] lg:hidden"
            aria-label="Open menu"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <line x1="4" y1="7" x2="20" y2="7" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="17" x2="20" y2="17" />
            </svg>
          </button>
          {activeRole && (
            <>
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-white"
                style={{ backgroundColor: activeRole.color }}
              >
                {activeRole.initials}
              </span>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[15px] font-semibold leading-tight">
                  {activeRole.name}
                </h1>
                <p className="truncate text-xs text-[#6f6d68]">
                  {activeRole.tagline}
                </p>
              </div>
            </>
          )}
          <button
            type="button"
            onClick={newChat}
            className="shrink-0 rounded-full border border-[#e6e3dd] bg-white px-3.5 py-2 text-sm font-medium shadow-sm transition hover:bg-[#f4f3f0]"
          >
            New chat
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {!activeRole ? (
            <div className="flex h-full items-center justify-center px-6 text-sm text-[#6f6d68]">
              {rolesError ?? "Loading roles…"}
            </div>
          ) : messages.length === 0 ? (
            <div className="mx-auto flex max-w-3xl flex-col items-center px-6 pb-10 pt-14 text-center sm:pt-20">
              <span
                className="flex h-14 w-14 items-center justify-center rounded-full text-lg font-bold text-white"
                style={{ backgroundColor: activeRole.color }}
              >
                {activeRole.initials}
              </span>
              <h2 className="mt-5 text-2xl font-bold tracking-tight sm:text-3xl">
                {activeRole.name}
              </h2>
              <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-[#6f6d68]">
                {activeRole.description}
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-2">
                {activeRole.suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void sendMessage(s)}
                    disabled={isStreaming}
                    className="rounded-full border border-[#e6e3dd] bg-white px-4 py-2 text-left text-sm shadow-sm transition hover:bg-[#f4f3f0] disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
              {messages.map((m, i) => (
                <div key={i} className="mb-7 flex gap-3">
                  {m.role === "assistant" ? (
                    <span
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                      style={{ backgroundColor: activeRole.color }}
                    >
                      {activeRole.initials}
                    </span>
                  ) : (
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#e6e3dd] text-[11px] font-bold text-[#6f6d68]">
                      You
                    </span>
                  )}
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className="mb-1 text-xs font-semibold text-[#6f6d68]">
                      {m.role === "assistant" ? activeRole.name : "You"}
                    </div>
                    {m.role === "assistant" ? (
                      m.content === "" ? (
                        <div className="flex items-center gap-1.5 py-1" aria-label="Thinking">
                          <span className="h-2 w-2 animate-pulse rounded-full bg-[#b8b4ac]" />
                          <span className="h-2 w-2 animate-pulse rounded-full bg-[#b8b4ac] [animation-delay:150ms]" />
                          <span className="h-2 w-2 animate-pulse rounded-full bg-[#b8b4ac] [animation-delay:300ms]" />
                        </div>
                      ) : (
                        <div className="markdown text-[15px]">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={mdComponents}
                          >
                            {m.content}
                          </ReactMarkdown>
                        </div>
                      )
                    ) : (
                      <div className="whitespace-pre-wrap text-[15px] leading-relaxed">
                        {m.content}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {isStreaming && !lastAssistantEmpty && (
                <div className="pb-2 pl-11 text-xs text-[#9a978f]">
                  Replying…
                </div>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-[#e6e3dd] bg-[#faf9f7] px-4 py-3">
          <div className="mx-auto max-w-3xl">
            <div className="flex items-end gap-2 rounded-2xl border border-[#e6e3dd] bg-white px-3 py-2 shadow-sm focus-within:ring-2 focus-within:ring-[#1f1e1c]/10">
              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onComposerKeyDown}
                placeholder={
                  activeRole
                    ? `Message ${activeRole.name}…`
                    : "Message SanRemes…"
                }
                className="max-h-[180px] flex-1 resize-none bg-transparent px-1 py-1.5 text-[15px] leading-relaxed outline-none placeholder:text-[#9a978f]"
                aria-label="Message"
              />
              {isStreaming ? (
                <button
                  type="button"
                  onClick={stopStreaming}
                  className="mb-0.5 flex h-9 shrink-0 items-center rounded-full bg-[#1f1e1c] px-3.5 text-sm font-medium text-white transition hover:bg-black"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void sendMessage(input)}
                  disabled={!input.trim() || !activeRole}
                  className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#1f1e1c] text-white transition hover:bg-black disabled:opacity-30"
                  aria-label="Send message"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
              )}
            </div>
            <p className="mt-2 text-center text-[11px] text-[#9a978f]">
              SanRemes can make mistakes. Check important information.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

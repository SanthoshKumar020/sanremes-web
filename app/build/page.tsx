// Website Builder — Phase 1 of the Autonomous AI Company OS.
// Loop: brief → Developer builds → deterministic tests → QA reviews
// → up to 3 fix rounds → preview → human approves → live link (Vercel).
// The Groq key and Vercel token live only in this browser.

"use client";

import { useEffect, useRef, useState } from "react";
import JSZip from "jszip";

const KEY_STORAGE = "sanremes-groq-key";
const TOKEN_STORAGE = "sanremes-vercel-token";

interface SiteFile {
  path: string;
  content: string;
}

interface TimelineEntry {
  step: string;
  status: "done" | "failed" | "skipped" | "info";
  detail: string;
}

interface QaIssue {
  severity: "critical" | "major" | "minor";
  file: string;
  description: string;
}

interface BuildResult {
  files: SiteFile[];
  testLog: string[];
  qaLog: string[];
  qaIssues: QaIssue[];
  timeline: TimelineEntry[];
  roundsUsed: number;
  costEstimate: number;
  costCap: number;
  status: "ready_for_review" | "escalated";
  escalatedReason?: string;
}

const PIPELINE_STEPS = [
  "Brief",
  "Build",
  "Tests",
  "QA review",
  "Fix rounds",
  "Preview",
  "Approval",
  "Deploy",
];

const EXAMPLE_BRIEF = {
  projectName: "sunrise-bakery",
  requirements:
    "A warm, welcoming landing page for Sunrise Bakery, a family bakery in Chennai. It should introduce the bakery, show our best sellers (sourdough, butter croissants, millet cookies), list opening hours and location, and have a simple order enquiry form that shows a thank-you message when submitted.",
  sections: "Hero, Best sellers, About us, Opening hours, Visit us, Order enquiry",
  styleNotes:
    "Warm cream and brown colours, friendly and simple, big readable text, works well on phones.",
};

/** Inline the site's own CSS/JS into index.html for the sandboxed preview. */
function buildPreviewDoc(files: SiteFile[]): string {
  const index = files.find((f) => f.path === "index.html");
  if (!index) return "";
  const cssFiles = files.filter((f) => f.path.endsWith(".css"));
  const jsFiles = files.filter((f) => f.path.endsWith(".js"));
  const cssPaths = new Set(cssFiles.map((f) => f.path));
  const jsPaths = new Set(jsFiles.map((f) => f.path));
  let html = index.content;
  // Remove only <link> tags that point at CSS files we are inlining.
  html = html.replace(
    /<link[^>]+href=["']([^"']+)["'][^>]*>/gi,
    (tag, href: string) => {
      const clean = String(href).split(/[?#]/)[0];
      return cssPaths.has(clean) ? "" : tag;
    }
  );
  // Remove only <script src> tags that point at JS files we are inlining.
  html = html.replace(
    /<script[^>]+src=["']([^"']+)["'][^>]*>\s*<\/script\s*>/gi,
    (tag, src: string) => {
      const clean = String(src).split(/[?#]/)[0];
      return jsPaths.has(clean) ? "" : tag;
    }
  );
  const css = cssFiles.map((f) => f.content).join("\n");
  if (css) {
    const styleTag = `<style>\n${css}\n</style>`;
    html = /<\/head\s*>/i.test(html)
      ? html.replace(/<\/head\s*>/i, `${styleTag}\n</head>`)
      : `${styleTag}\n${html}`;
  }
  const js = jsFiles.map((f) => f.content).join("\n");
  if (js) {
    const scriptTag = `<script>\n${js}\n</script>`;
    html = /<\/body\s*>/i.test(html)
      ? html.replace(/<\/body\s*>/i, `${scriptTag}\n</body>`)
      : `${html}\n${scriptTag}`;
  }
  return html;
}

function formatCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

function severityBadge(severity: QaIssue["severity"]): string {
  if (severity === "critical") return "bg-red-100 text-[#b3261e]";
  if (severity === "major") return "bg-amber-100 text-amber-800";
  return "bg-[#eceae5] text-[#6f6d68]";
}

export default function WebsiteBuilder() {
  const [projectName, setProjectName] = useState("");
  const [requirements, setRequirements] = useState("");
  const [sections, setSections] = useState("");
  const [styleNotes, setStyleNotes] = useState("");
  const [costCap, setCostCap] = useState("0.50");
  const [groqKey, setGroqKey] = useState("");
  const [vercelToken, setVercelToken] = useState("");
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [building, setBuilding] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BuildResult | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [deployUrl, setDeployUrl] = useState<string | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Prefill keys from this browser only (same storage as the chat sidebar).
  useEffect(() => {
    try {
      const k = localStorage.getItem(KEY_STORAGE) ?? "";
      if (k) {
        setGroqKey(k);
        setHasStoredKey(true);
      }
      const t = localStorage.getItem(TOKEN_STORAGE) ?? "";
      if (t) setVercelToken(t);
    } catch {
      // Storage unavailable; keys stay session-only.
    }
  }, []);

  // Elapsed-time clock while a build runs.
  useEffect(() => {
    if (building) {
      const started = Date.now();
      timerRef.current = setInterval(
        () => setElapsed(Math.floor((Date.now() - started) / 1000)),
        1000
      );
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [building]);

  const saveKeysToBrowser = () => {
    try {
      if (groqKey.trim()) localStorage.setItem(KEY_STORAGE, groqKey.trim());
      if (vercelToken.trim())
        localStorage.setItem(TOKEN_STORAGE, vercelToken.trim());
    } catch {
      // Storage unavailable; keys stay for this session only.
    }
  };

  const loadExample = () => {
    setProjectName(EXAMPLE_BRIEF.projectName);
    setRequirements(EXAMPLE_BRIEF.requirements);
    setSections(EXAMPLE_BRIEF.sections);
    setStyleNotes(EXAMPLE_BRIEF.styleNotes);
    setError(null);
  };

  const startBuild = async () => {
    if (building) return;
    if (!groqKey.trim()) {
      setError(
        "Add your free Groq API key first — paste it below, or save one in the chat sidebar. Get a free key at console.groq.com/keys."
      );
      return;
    }
    if (requirements.trim().length < 10) {
      setError("Please describe the website in at least a few words.");
      return;
    }
    saveKeysToBrowser();
    setBuilding(true);
    setElapsed(0);
    setError(null);
    setResult(null);
    setDeployUrl(null);
    setDeployError(null);
    try {
      const res = await fetch("/api/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectName: projectName.trim() || "my-website",
          requirements: requirements.trim(),
          sections,
          styleNotes,
          costCap: parseFloat(costCap) || 0.5,
          apiKey: groqKey.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<BuildResult> & {
        error?: string;
        timeline?: TimelineEntry[];
      };
      if (!res.ok) {
        throw new Error(data.error || `Build failed (${res.status})`);
      }
      if (!Array.isArray(data.files)) {
        throw new Error("The build returned no files.");
      }
      setResult({
        files: data.files,
        testLog: data.testLog ?? [],
        qaLog: data.qaLog ?? [],
        qaIssues: data.qaIssues ?? [],
        timeline: data.timeline ?? [],
        roundsUsed: data.roundsUsed ?? 0,
        costEstimate: data.costEstimate ?? 0,
        costCap: data.costCap ?? (parseFloat(costCap) || 0.5),
        status: data.status ?? "escalated",
        escalatedReason: data.escalatedReason,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "The build failed.");
    } finally {
      setBuilding(false);
    }
  };

  const downloadZip = async () => {
    if (!result) return;
    const zip = new JSZip();
    for (const f of result.files) zip.file(f.path, f.content);
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(projectName.trim() || "website").replace(/[^a-z0-9-]/gi, "-")}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const downloadSingleHtml = () => {
    if (!result) return;
    const doc = buildPreviewDoc(result.files);
    const blob = new Blob([doc], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(projectName.trim() || "website").replace(/[^a-z0-9-]/gi, "-")}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const deploy = async () => {
    if (!result || deploying) return;
    if (!vercelToken.trim()) {
      setDeployError(
        "A Vercel token is needed for a live link. Create one at vercel.com/account/tokens and paste it above — it stays in your browser."
      );
      return;
    }
    saveKeysToBrowser();
    setDeploying(true);
    setDeployError(null);
    setDeployUrl(null);
    try {
      const res = await fetch("/api/build/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: result.files,
          projectName: projectName.trim() || "my-website",
          vercelToken: vercelToken.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        url?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || `Deploy failed (${res.status})`);
      }
      if (!data.url) throw new Error("Vercel did not return a live URL.");
      setDeployUrl(data.url);
    } catch (err) {
      setDeployError(
        err instanceof Error ? err.message : "The deploy failed."
      );
    } finally {
      setDeploying(false);
    }
  };

  const previewDoc = result ? buildPreviewDoc(result.files) : "";
  const isSingleFile = result?.files.length === 1;
  const canDeploy = result?.status === "ready_for_review";

  return (
    <div className="min-h-dvh bg-[#faf9f7] text-[#1f1e1c]">
      <header className="border-b border-[#e6e3dd]">
        <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6">
          <a
            href="/"
            className="text-sm text-[#6f6d68] transition hover:text-[#1f1e1c]"
          >
            ← Back to chat
          </a>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">
            Website Builder
          </h1>
          <p className="mt-1 text-sm leading-relaxed text-[#6f6d68]">
            Describe a website in plain English. A Developer agent builds it,
            deterministic tests and a QA agent check it, fixes go back to the
            Developer (max 3 rounds), then you preview it and approve the live
            link. Nothing goes live without your approval.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        {/* Brief form */}
        <section className="rounded-2xl border border-[#e6e3dd] bg-white p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">1 · Your brief</h2>
            <button
              type="button"
              onClick={loadExample}
              className="text-sm font-medium text-[#1d4ed8] underline underline-offset-2"
            >
              Try an example brief
            </button>
          </div>

          <label htmlFor="project-name" className="mt-4 block text-sm font-semibold">
            Project name
          </label>
          <input
            id="project-name"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="e.g. sunrise-bakery"
            maxLength={60}
            className="mt-1.5 w-full rounded-xl border border-[#e6e3dd] bg-[#faf9f7] px-3 py-2.5 text-[15px] outline-none placeholder:text-[#9a978f] focus:ring-2 focus:ring-[#1f1e1c]/10"
          />
          <p className="mt-1 text-xs text-[#9a978f]">
            Lowercase letters, numbers and hyphens — this becomes the live
            site&apos;s address on Vercel.
          </p>

          <label htmlFor="requirements" className="mt-4 block text-sm font-semibold">
            What should the website do?
          </label>
          <textarea
            id="requirements"
            rows={4}
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
            placeholder="Describe the website in plain English — what it is for, who it is for, what it must show and do…"
            className="mt-1.5 w-full resize-y rounded-xl border border-[#e6e3dd] bg-[#faf9f7] px-3 py-2.5 text-[15px] leading-relaxed outline-none placeholder:text-[#9a978f] focus:ring-2 focus:ring-[#1f1e1c]/10"
          />

          <label htmlFor="sections" className="mt-4 block text-sm font-semibold">
            Pages / sections wanted
          </label>
          <input
            id="sections"
            value={sections}
            onChange={(e) => setSections(e.target.value)}
            placeholder="e.g. Hero, Best sellers, About us, Opening hours, Contact"
            className="mt-1.5 w-full rounded-xl border border-[#e6e3dd] bg-[#faf9f7] px-3 py-2.5 text-[15px] outline-none placeholder:text-[#9a978f] focus:ring-2 focus:ring-[#1f1e1c]/10"
          />
          <p className="mt-1 text-xs text-[#9a978f]">
            Comma-separated. The tests check that each of these actually
            appears on the page.
          </p>

          <label htmlFor="style-notes" className="mt-4 block text-sm font-semibold">
            Style notes <span className="font-normal text-[#9a978f]">(optional)</span>
          </label>
          <input
            id="style-notes"
            value={styleNotes}
            onChange={(e) => setStyleNotes(e.target.value)}
            placeholder="e.g. Warm cream and brown, friendly, big text, works on phones"
            className="mt-1.5 w-full rounded-xl border border-[#e6e3dd] bg-[#faf9f7] px-3 py-2.5 text-[15px] outline-none placeholder:text-[#9a978f] focus:ring-2 focus:ring-[#1f1e1c]/10"
          />

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="cost-cap" className="block text-sm font-semibold">
                Cost cap (USD)
              </label>
              <input
                id="cost-cap"
                type="number"
                min="0.10"
                max="2"
                step="0.05"
                value={costCap}
                onChange={(e) => setCostCap(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-[#e6e3dd] bg-[#faf9f7] px-3 py-2.5 text-[15px] outline-none focus:ring-2 focus:ring-[#1f1e1c]/10"
              />
              <p className="mt-1 text-xs text-[#9a978f]">
                Default $0.50. The build stops immediately if it is hit.
              </p>
            </div>
            <div>
              <label htmlFor="groq-key" className="block text-sm font-semibold">
                Groq API key
              </label>
              <input
                id="groq-key"
                type="password"
                value={groqKey}
                onChange={(e) => setGroqKey(e.target.value)}
                placeholder="gsk_…"
                className="mt-1.5 w-full rounded-xl border border-[#e6e3dd] bg-[#faf9f7] px-3 py-2.5 font-mono text-[13px] outline-none placeholder:text-[#9a978f] focus:ring-2 focus:ring-[#1f1e1c]/10"
              />
              <p className="mt-1 text-xs text-[#9a978f]">
                {hasStoredKey
                  ? "Filled from the key saved in this browser."
                  : "Free key at console.groq.com/keys — stays in your browser only."}
              </p>
            </div>
          </div>

          <label htmlFor="vercel-token" className="mt-4 block text-sm font-semibold">
            Vercel token <span className="font-normal text-[#9a978f]">(optional — only needed for a live link)</span>
          </label>
          <input
            id="vercel-token"
            type="password"
            value={vercelToken}
            onChange={(e) => setVercelToken(e.target.value)}
            placeholder="Paste a token from vercel.com/account/tokens"
            className="mt-1.5 w-full rounded-xl border border-[#e6e3dd] bg-[#faf9f7] px-3 py-2.5 font-mono text-[13px] outline-none placeholder:text-[#9a978f] focus:ring-2 focus:ring-[#1f1e1c]/10"
          />
          <p className="mt-1 text-xs text-[#9a978f]">
            Without a token you can still preview and download the site — a
            live link needs the token. It is sent only to Vercel, never stored
            on the server.
          </p>

          {!groqKey.trim() && (
            <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Add your free Groq API key above (or save one in the chat
              sidebar) — the build cannot start without it.
            </p>
          )}
          {error && (
            <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-[#b3261e]">
              {error}
            </p>
          )}
          <div className="mt-5">
            <button
              type="button"
              onClick={() => void startBuild()}
              disabled={building}
              className="rounded-full bg-[#1f1e1c] px-6 py-2.5 text-sm font-medium text-white transition hover:bg-black disabled:opacity-40"
            >
              {building ? "Building…" : "Build my website"}
            </button>
          </div>
        </section>

        {/* Pipeline / running state */}
        {(building || result) && (
          <section className="mt-6 rounded-2xl border border-[#e6e3dd] bg-white p-5">
            <h2 className="text-lg font-semibold">2 · Pipeline</h2>
            <ol className="mt-4 space-y-2">
              {PIPELINE_STEPS.map((label) => {
                const entry = result?.timeline.find((t) =>
                  t.step.toLowerCase().startsWith(label.toLowerCase().split(" ")[0])
                );
                let state:
                  | "done"
                  | "failed"
                  | "skipped"
                  | "info"
                  | "running"
                  | "pending";
                if (building) {
                  state = label === "Build" ? "running" : "pending";
                } else if (entry) {
                  state = entry.status;
                } else if (result) {
                  if (label === "Brief" || label === "Preview") state = "done";
                  else if (label === "Approval")
                    state =
                      result.status === "ready_for_review" ? "done" : "failed";
                  else if (label === "Fix rounds")
                    state = result.roundsUsed > 0 ? "done" : "skipped";
                  else if (label === "Deploy")
                    state = deployUrl ? "done" : "pending";
                  else state = "pending";
                } else {
                  state = "pending";
                }
                return (
                  <li key={label} className="flex items-start gap-3">
                    <span
                      className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                        state === "done"
                          ? "bg-green-700 text-white"
                          : state === "failed"
                            ? "bg-red-600 text-white"
                            : state === "running"
                              ? "bg-[#1f1e1c] text-white"
                              : state === "skipped"
                                ? "bg-[#eceae5] text-[#9a978f]"
                                : "bg-[#e6e3dd] text-[#6f6d68]"
                      }`}
                    >
                      {state === "done"
                        ? "✓"
                        : state === "failed"
                          ? "✕"
                          : state === "running"
                            ? "…"
                            : "·"}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{label}</p>
                      {entry && (
                        <p className="text-sm leading-relaxed text-[#6f6d68]">
                          {entry.detail}
                        </p>
                      )}
                      {building && label === "Build" && (
                        <p className="text-sm text-[#6f6d68]">
                          Working… {elapsed}s elapsed. Builds usually take
                          1–3 minutes.
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>

            {result && (
              <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-[#e6e3dd] bg-[#faf9f7] px-4 py-3 text-sm">
                <span
                  className={`rounded-full px-3 py-1 text-xs font-bold ${
                    result.status === "ready_for_review"
                      ? "bg-green-100 text-green-800"
                      : "bg-amber-100 text-amber-800"
                  }`}
                >
                  {result.status === "ready_for_review"
                    ? "Ready for review"
                    : "Escalated — needs you"}
                </span>
                <span>
                  Cost: <strong>{formatCost(result.costEstimate)}</strong>{" "}
                  <span className="text-[#9a978f]">
                    (estimate, cap {formatCost(result.costCap)})
                  </span>
                </span>
                <span>
                  Fix rounds used: <strong>{result.roundsUsed} / 3</strong>
                </span>
                {result.escalatedReason && (
                  <p className="w-full text-sm leading-relaxed text-amber-800">
                    {result.escalatedReason}
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        {/* Logs */}
        {result && (
          <section className="mt-6 space-y-5">
            <div className="rounded-2xl border border-[#e6e3dd] bg-white p-5">
              <h2 className="text-lg font-semibold">Test log</h2>
              <ul className="mt-3 space-y-1.5 font-mono text-[13px] leading-relaxed">
                {result.testLog.map((line, i) => (
                  <li
                    key={i}
                    className={
                      line.startsWith("FAIL")
                        ? "text-[#b3261e]"
                        : "text-[#3d3b38]"
                    }
                  >
                    {line}
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-2xl border border-[#e6e3dd] bg-white p-5">
              <h2 className="text-lg font-semibold">QA log</h2>
              {result.qaIssues.length === 0 ? (
                <p className="mt-2 text-sm text-[#6f6d68]">
                  {result.qaLog[0] ?? "QA review: pass — no issues found."}
                </p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {result.qaIssues.map((issue, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <span
                        className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${severityBadge(issue.severity)}`}
                      >
                        {issue.severity}
                      </span>
                      <span>
                        <span className="font-mono text-[13px]">{issue.file}</span>
                        {" — "}
                        {issue.description}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Preview */}
            <div className="rounded-2xl border border-[#e6e3dd] bg-white p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">3 · Preview</h2>
                <span className="text-sm text-[#6f6d68]">
                  {result.files.length} file(s):{" "}
                  {result.files
                    .map((f) => `${f.path} (${f.content.length.toLocaleString()} chars)`)
                    .join(", ")}
                </span>
              </div>
              <div className="mt-4 overflow-hidden rounded-xl border border-[#e6e3dd]">
                <iframe
                  title="Website preview"
                  sandbox="allow-scripts"
                  srcDoc={previewDoc}
                  className="h-[560px] w-full bg-white"
                />
              </div>
              <p className="mt-2 text-xs text-[#9a978f]">
                Preview runs in a sandboxed frame — the site cannot reach this
                page or the internet from here.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void downloadZip()}
                  className="rounded-full bg-[#1f1e1c] px-5 py-2.5 text-sm font-medium text-white transition hover:bg-black"
                >
                  Download .zip
                </button>
                {isSingleFile && (
                  <button
                    type="button"
                    onClick={downloadSingleHtml}
                    className="rounded-full border border-[#e6e3dd] bg-white px-4 py-2.5 text-sm font-medium shadow-sm transition hover:bg-[#f4f3f0]"
                  >
                    Download single HTML file
                  </button>
                )}
              </div>
            </div>

            {/* Approval + deploy */}
            <div className="rounded-2xl border border-[#e6e3dd] bg-white p-5">
              <h2 className="text-lg font-semibold">4 · Approve &amp; deploy</h2>
              {!canDeploy && (
                <p className="mt-2 text-sm leading-relaxed text-amber-800">
                  Deploy is locked until the tests pass. This build was
                  escalated — fix the issues above (or reword the brief and
                  rebuild), or download the files and fix them yourself.
                </p>
              )}
              {canDeploy && (
                <p className="mt-2 text-sm leading-relaxed text-[#6f6d68]">
                  Tests passed and QA found no blocking issues. Approving here
                  deploys this exact version to Vercel as a live link.
                </p>
              )}
              {deployError && (
                <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-[#b3261e]">
                  {deployError}
                </p>
              )}
              {deployUrl && (
                <p className="mt-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm">
                  Live:{" "}
                  <a
                    href={deployUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-semibold text-[#1d4ed8] underline underline-offset-2"
                  >
                    {deployUrl}
                  </a>
                </p>
              )}
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void deploy()}
                  disabled={!canDeploy || deploying}
                  className="rounded-full bg-[#1f1e1c] px-5 py-2.5 text-sm font-medium text-white transition hover:bg-black disabled:opacity-40"
                >
                  {deploying ? "Deploying…" : "Approve & deploy to Vercel"}
                </button>
                {!vercelToken.trim() && canDeploy && (
                  <span className="self-center text-sm text-[#6f6d68]">
                    No Vercel token yet — add one above to get a live link.
                  </span>
                )}
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

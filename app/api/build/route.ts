// POST /api/build — the Phase 1 orchestrator for the Website Builder.
//
// Fixed workflow in code (NOT free-form agent chat):
//   Developer (Full-Stack role) → deterministic test gate → QA (QA role)
//   → fix loop (max 3 fix rounds) → result for human review.
// The LLM only writes files. Nothing generated is executed server-side.
// Cost is estimated per Groq call (characters / 4 tokens) at the
// gpt-oss-120b list rates; a per-task cost cap stops the loop immediately.
//
// Long builds can take a few minutes; the route allows up to 300s where the
// host plan permits (Vercel Hobby caps this at 60s — a slow build there
// returns a timeout instead of a result; the UI says so plainly).

import { NextRequest, NextResponse } from "next/server";
import { getRole } from "@/lib/roles";
import {
  runTestGate,
  validateFiles,
  estimateCostUsd,
  type SiteFile,
} from "@/lib/build";

export const maxDuration = 300;

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "openai/gpt-oss-120b";
const MAX_FIX_ROUNDS = 3;
const DEFAULT_COST_CAP = 0.5;
const MAX_COST_CAP = 2;

const DEV_SYSTEM_EXTRA = `
## Your current task
You are building a complete static website from the user's brief below. This is
real work, not a demo: the site must be finished, with real copy (never
placeholder text), a responsive layout, and working navigation.

Output ONLY a JSON object with this exact shape — no markdown, no code fences,
no extra text:
{
  "files": [
    { "path": "index.html", "content": "<!doctype html>..." },
    { "path": "styles.css", "content": "..." },
    { "path": "script.js", "content": "..." }
  ],
  "summary": "<2-3 plain sentences describing the site you built>"
}

Rules:
- Return 1 to 6 files. "index.html" is required. Use "styles.css" and
  "script.js" when the site needs them; a single self-contained index.html is
  also fine.
- Only .html, .css and .js files. No other file types, no server code.
- The HTML must be a complete document: <!doctype html>, <html>, <head> with
  a real <title> and <meta name="viewport">, and <body>.
- Write REAL copy that fits the brief — full sentences, real headings, real
  button labels. NEVER write lorem ipsum, TODO, FIXME, "coming soon", "sample
  text", or any other filler.
- Every section the brief asks for must appear on the page, with real content.
- Use a system font stack only. Do not load external images, fonts or
  libraries — visuals must be CSS or inline SVG, so the site works offline.
- Internal links (href/src) may only point to files you return, or to #anchors
  that exist on the page. No external <script> or <link> tags.
- Keep the JavaScript small and defensive: only touch elements that exist.
- If a fix round lists problems, fix exactly those problems and keep
  everything else that already worked.
`;

const QA_SYSTEM_EXTRA = `
## Your current task
You are reviewing a static website (files below) against the user's brief.
Return ONLY a JSON object with this exact shape — no markdown, no code fences,
no extra text:
{
  "verdict": "pass" | "fail",
  "issues": [
    { "severity": "critical" | "major" | "minor", "file": "index.html", "description": "<one concrete sentence>" }
  ]
}

Check, in this order:
1. Broken links — every internal href/src must point to a file in the set or
   an #anchor that exists.
2. Missing content — every section the brief asked for must be present with
   real copy.
3. Placeholder text — lorem ipsum, TODO, FIXME, "coming soon", filler.
4. Layout and responsiveness — viewport meta, mobile layout, overflow risks.
5. JavaScript risks — code that touches elements that do not exist, undefined
   variables, anything that would throw in the console.
6. Accessibility basics — images need alt text, form fields need labels.

Severity guide: "critical" = the site is broken or a brief requirement is
missing. "major" = visibly wrong or likely to break for many visitors.
"minor" = polish (wording, spacing, a small improvement). Only list issues
you are sure about — do not invent problems.
Set "verdict" to "fail" only if there is at least one critical or major issue.
Minor issues are reported but do not fail the review.
`;

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("The AI did not return JSON.");
    return JSON.parse(match[0]);
  }
}

function cleanGroqError(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (parsed?.error?.message) return parsed.error.message;
  } catch {
    // Fall through to the raw text.
  }
  return text ? text.slice(0, 300) : `AI service returned ${status}.`;
}

async function callGroq(
  apiKey: string,
  system: string,
  user: string,
  temperature: number,
  maxTokens: number
): Promise<{ text: string; inputChars: number; outputChars: number }> {
  const inputChars = system.length + user.length;
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
        temperature,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } catch {
    throw new Error("Could not reach the AI service. Please try again.");
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    throw new Error(cleanGroqError(upstream.status, text));
  }
  const data = (await upstream.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  const text = data?.choices?.[0]?.message?.content ?? "";
  if (!text) {
    throw new Error("The AI service returned an empty response.");
  }
  return { text, inputChars, outputChars: text.length };
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const projectName =
    typeof body.projectName === "string" ? body.projectName.trim() : "";
  const requirements =
    typeof body.requirements === "string" ? body.requirements.trim() : "";
  const sectionsRaw =
    typeof body.sections === "string" ? body.sections.trim() : "";
  const styleNotes =
    typeof body.styleNotes === "string" ? body.styleNotes.trim() : "";
  const costCapRaw = body.costCap;

  if (projectName.length < 1 || projectName.length > 60) {
    return NextResponse.json(
      { error: "projectName must be 1–60 characters." },
      { status: 400 }
    );
  }
  if (requirements.length < 10 || requirements.length > 4000) {
    return NextResponse.json(
      { error: "requirements must be 10–4000 characters." },
      { status: 400 }
    );
  }
  if (sectionsRaw.length > 1000) {
    return NextResponse.json(
      { error: "sections must be 1000 characters or fewer." },
      { status: 400 }
    );
  }
  if (styleNotes.length > 1000) {
    return NextResponse.json(
      { error: "styleNotes must be 1000 characters or fewer." },
      { status: 400 }
    );
  }
  const costCap =
    typeof costCapRaw === "number" &&
    Number.isFinite(costCapRaw) &&
    costCapRaw > 0
      ? Math.min(costCapRaw, MAX_COST_CAP)
      : DEFAULT_COST_CAP;

  const sections = sectionsRaw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);

  // Bring-your-own-key: a key sent with the request wins over the server key.
  // The key is never logged or stored server-side.
  const bodyApiKey =
    typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const apiKey = bodyApiKey || process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "No API key is set. Add your free Groq API key in the sidebar (or in the Website Builder form) — it stays in your browser.",
      },
      { status: 500 }
    );
  }

  const devRole = getRole("fullstack-developer");
  const qaRole = getRole("qa-engineer");
  if (!devRole || !qaRole) {
    return NextResponse.json(
      { error: "Developer or QA role is not configured." },
      { status: 500 }
    );
  }
  const devSystem = `${devRole.systemPrompt}\n${DEV_SYSTEM_EXTRA}`;
  const qaSystem = `${qaRole.systemPrompt}\n${QA_SYSTEM_EXTRA}`;

  const brief = [
    `Project name: ${projectName}`,
    `Requirements: ${requirements}`,
    sections.length > 0
      ? `Pages / sections wanted: ${sections.join(", ")}`
      : "Pages / sections wanted: (none specified — use your judgement)",
    styleNotes ? `Style notes: ${styleNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const timeline: TimelineEntry[] = [];
  const testLog: string[] = [];
  const qaLog: string[] = [];
  let costEstimate = 0;
  let fixRounds = 0;
  let files: SiteFile[] | null = null;
  let lastQaIssues: QaIssue[] = [];
  let status: "ready_for_review" | "escalated" = "escalated";
  let escalatedReason = "The build did not finish.";

  const addCost = (inputChars: number, outputChars: number) => {
    costEstimate += estimateCostUsd(inputChars, outputChars);
  };
  const overCap = () => costEstimate >= costCap;

  try {
    // --- Step 1: Developer builds the site. ---
    timeline.push({
      step: "Build",
      status: "done",
      detail: `Developer agent is building "${projectName}".`,
    });
    let devText: string;
    try {
      const res = await callGroq(apiKey, devSystem, brief, 0.3, 8192);
      addCost(res.inputChars, res.outputChars);
      devText = res.text;
    } catch (err) {
      throw new Error(
        err instanceof Error ? err.message : "Developer step failed."
      );
    }
    let parsed: unknown;
    try {
      parsed = extractJson(devText);
    } catch {
      // One retry with an explicit "JSON only" nudge.
      if (overCap()) {
        return NextResponse.json(
          {
            error: `The AI did not return a valid website (bad JSON), and the cost cap of $${costCap.toFixed(2)} was reached before a retry. Try rewording the brief.`,
            costEstimate: roundCost(costEstimate),
            timeline,
          },
          { status: 502 }
        );
      }
      const retry = await callGroq(
        apiKey,
        devSystem,
        `${brief}\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object described in the system prompt — no markdown, no code fences, no extra text.`,
        0.3,
        8192
      );
      addCost(retry.inputChars, retry.outputChars);
      try {
        parsed = extractJson(retry.text);
      } catch {
        return NextResponse.json(
          {
            error:
              "The AI did not return a valid website (bad JSON) after two tries. Try rewording the brief.",
            costEstimate: roundCost(costEstimate),
            timeline,
          },
          { status: 502 }
        );
      }
    }
    const validated = validateFiles(parsed);
    if ("error" in validated) {
      return NextResponse.json(
        {
          error: `The AI website failed validation: ${validated.error}`,
          costEstimate: roundCost(costEstimate),
          timeline,
        },
        { status: 502 }
      );
    }
    files = validated.files;
    timeline.push({
      step: "Build",
      status: "done",
      detail: `Built ${files.length} file(s): ${files.map((f) => f.path).join(", ")}.`,
    });

    // --- Steps 2–3: test gate, then QA, then fix rounds. ---
    for (;;) {
      // Deterministic test gate (no LLM).
      const gate = runTestGate(files, sections);
      for (const c of gate.checks) {
        testLog.push(`${c.passed ? "PASS" : "FAIL"} — ${c.name}: ${c.detail}`);
      }
      timeline.push({
        step: "Tests",
        status: gate.passed ? "done" : "failed",
        detail: gate.passed
          ? `All ${gate.checks.length} deterministic checks passed.`
          : `${gate.failures.length} check(s) failed.`,
      });

      // QA review (LLM, structured JSON).
      let qaIssues: QaIssue[] = [];
      let qaVerdict: "pass" | "fail" = "pass";
      if (overCap()) {
        qaLog.push("QA review skipped — cost cap reached.");
        timeline.push({
          step: "QA review",
          status: "skipped",
          detail: "Skipped — cost cap reached.",
        });
        escalatedReason = `Cost cap of $${costCap.toFixed(2)} reached. The last built version is returned for your review.`;
        break;
      }
      try {
        const qaUser = JSON.stringify({
          brief,
          files: files.map((f) => ({ path: f.path, content: f.content })),
          testGateFailures: gate.failures,
        });
        const qaRes = await callGroq(apiKey, qaSystem, qaUser, 0.2, 2048);
        addCost(qaRes.inputChars, qaRes.outputChars);
        const qaParsed = extractJson(qaRes.text) as {
          verdict?: unknown;
          issues?: unknown;
        };
        if (isRecord(qaParsed) && Array.isArray(qaParsed.issues)) {
          qaIssues = (qaParsed.issues as unknown[])
            .filter(isRecord)
            .map((i) => {
              const severityRaw =
                typeof i.severity === "string" ? i.severity : "";
              const severity: QaIssue["severity"] =
                severityRaw === "critical" ||
                severityRaw === "major" ||
                severityRaw === "minor"
                  ? severityRaw
                  : "minor";
              return {
                severity,
                file: typeof i.file === "string" ? i.file : "index.html",
                description:
                  typeof i.description === "string" ? i.description : "",
              };
            })
            .filter((i) => i.description.length > 0);
          qaVerdict =
            qaParsed.verdict === "fail" ||
            qaIssues.some(
              (i) => i.severity === "critical" || i.severity === "major"
            )
              ? "fail"
              : "pass";
        } else {
          qaLog.push("QA review returned no usable issues list — treated as a pass with a warning.");
        }
      } catch (err) {
        // A QA failure must not kill a build that passed the deterministic
        // gate — log it and carry on with the gate result alone.
        qaLog.push(
          `QA review could not run (${err instanceof Error ? err.message : "unknown error"}) — continuing with the test-gate result only.`
        );
      }
      lastQaIssues = qaIssues;
      if (qaIssues.length === 0) {
        qaLog.push("QA review: pass — no issues found.");
      } else {
        for (const i of qaIssues) {
          qaLog.push(
            `${i.severity.toUpperCase()} — ${i.file}: ${i.description}`
          );
        }
      }
      timeline.push({
        step: "QA review",
        status: qaVerdict === "pass" ? "done" : "failed",
        detail:
          qaVerdict === "pass"
            ? qaIssues.length === 0
              ? "No issues found."
              : `${qaIssues.length} minor issue(s) noted — not blocking.`
            : `${qaIssues.filter((i) => i.severity !== "minor").length} blocking issue(s) found.`,
      });

      const blocking =
        !gate.passed ||
        qaIssues.some((i) => i.severity === "critical" || i.severity === "major");
      if (!blocking) {
        status = "ready_for_review";
        escalatedReason = "";
        break;
      }

      // Fix loop: max 3 fix rounds, then escalate with the best version.
      if (fixRounds >= MAX_FIX_ROUNDS) {
        escalatedReason = `Stopped after ${MAX_FIX_ROUNDS} fix rounds with issues still open. The best version is returned below — review it, or reword the brief and try again.`;
        break;
      }
      if (overCap()) {
        escalatedReason = `Cost cap of $${costCap.toFixed(2)} reached during fix rounds. The best version is returned below.`;
        break;
      }
      fixRounds += 1;
      const fixFeedback = [
        "Fix the following problems in the website. Keep everything else that already worked.",
        "",
        "Deterministic test failures:",
        ...gate.failures.map((f) => `- ${f}`),
        "",
        "QA issues:",
        ...(qaIssues.length > 0
          ? qaIssues.map((i) => `- [${i.severity}] ${i.file}: ${i.description}`)
          : ["- (none)"]),
        "",
        "Current files (edit these, return the full corrected set):",
        JSON.stringify({ files }),
      ].join("\n");
      timeline.push({
        step: `Fix round ${fixRounds}`,
        status: "done",
        detail: `Sending ${gate.failures.length + qaIssues.length} issue(s) back to the Developer.`,
      });
      let fixText: string;
      try {
        const fixRes = await callGroq(apiKey, devSystem, fixFeedback, 0.3, 8192);
        addCost(fixRes.inputChars, fixRes.outputChars);
        fixText = fixRes.text;
      } catch (err) {
        escalatedReason = `Developer fix round failed: ${err instanceof Error ? err.message : "unknown error"}. The best version so far is returned below.`;
        break;
      }
      let fixParsed: unknown;
      try {
        fixParsed = extractJson(fixText);
      } catch {
        escalatedReason =
          "The Developer returned invalid JSON on a fix round. The best version so far is returned below.";
        break;
      }
      const fixValidated = validateFiles(fixParsed);
      if ("error" in fixValidated) {
        escalatedReason = `The Developer's fix round failed validation: ${fixValidated.error} The best version so far is returned below.`;
        break;
      }
      files = fixValidated.files;
    }
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "The build failed.",
        costEstimate: roundCost(costEstimate),
        timeline,
        testLog,
        qaLog,
      },
      { status: 502 }
    );
  }

  function roundCost(c: number): number {
    return Math.round(c * 10000) / 10000;
  }

  function buildResponse() {
    return NextResponse.json({
      files,
      testLog,
      qaLog,
      qaIssues: lastQaIssues,
      timeline,
      roundsUsed: fixRounds,
      costEstimate: roundCost(costEstimate),
      costCap,
      status,
      ...(status === "escalated" ? { escalatedReason } : {}),
    });
  }

  return buildResponse();
}

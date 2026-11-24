import { NextRequest, NextResponse } from "next/server";
import { runPlan } from "@/lib/transform";
import type { PlanStep, Row } from "@/lib/transform";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "openai/gpt-oss-120b";

const SYSTEM_PROMPT = `You are a data-engineering planner. A user has a table and a plain-English request. Your job is to turn the request into a safe, ordered plan of data-cleaning steps.

Output ONLY a JSON object with this exact shape:
{
  "plan": [
    { "op": "<operation>", ...params, "reason": "<one plain sentence>" }
  ],
  "summary": "<2-3 plain sentences describing what the plan will do>",
  "warnings": ["<anything risky, e.g. a step that drops rows, or a column the request mentions that does not exist>"]
}

You may ONLY use these 12 operations, with exactly these parameters:
1. drop_duplicates { "columns": ["col", ...] } — drop rows that duplicate on the given columns; omit "columns" to dedupe on all columns.
2. drop_missing { "column": "col" } — drop rows where the column is empty.
3. fill_missing { "column": "col", "value": "literal" } — fill empty cells with a literal value.
4. trim { "column": "col" } — trim whitespace.
5. change_case { "column": "col", "mode": "lower" | "upper" | "title" } — change text case.
6. rename_column { "from": "old", "to": "new" } — rename a column.
7. drop_column { "column": "col" } — remove a column.
8. convert_type { "column": "col", "to": "number" | "date" } — "number" strips commas/currency then parses (invalid becomes empty); "date" parses common formats and outputs YYYY-MM-DD (unparseable becomes empty).
9. filter_rows { "column": "col", "operator": "equals" | "not_equals" | "greater_than" | "less_than" | "contains", "value": "literal" } — keep only matching rows.
10. sort { "column": "col", "direction": "asc" | "desc" } — sort rows.
11. group_aggregate { "groupBy": ["col", ...], "aggregations": [{ "column": "col", "fn": "sum" | "mean" | "count" | "min" | "max", "as": "new_column_name" }] } — one row per group. Use this whenever the user asks for totals, averages or counts grouped by something.
12. replace_values { "column": "col", "from": "old", "to": "new" } — exact-match replace.

Rules:
- Every step must reference columns that exist in the input, or columns created by an earlier step (a rename creates the new name; a group_aggregate creates the group-by columns and the "as" columns, and removes all other columns).
- Never invent a column that does not exist. If the request mentions a column that is not in the table, do not create a step for it — say so in "warnings" instead.
- Only add steps the request actually asks for. Do not add extra "helpful" steps.
- Keep the plan short: merge steps where one step does the job.
- Every step needs a "reason" in one plain sentence.
- "summary" is 2-3 plain sentences, no jargon.
- "warnings" lists anything risky: steps that drop rows, steps that may empty a column, or request parts you could not map to a column.
- Output JSON only. No markdown, no code fences, no extra text.`;

const KNOWN_OPS = new Set([
  "drop_duplicates",
  "drop_missing",
  "fill_missing",
  "trim",
  "change_case",
  "rename_column",
  "drop_column",
  "convert_type",
  "filter_rows",
  "sort",
  "group_aggregate",
  "replace_values",
]);

interface PlanResponse {
  plan: PlanStep[];
  summary: string;
  warnings: string[];
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // The model may wrap the JSON in prose; take the first {...} block.
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("The AI did not return JSON.");
    return JSON.parse(match[0]);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
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

  const { columns, sampleRows, rowCount, requirements } = body as {
    columns?: unknown;
    sampleRows?: unknown;
    rowCount?: unknown;
    requirements?: unknown;
    apiKey?: unknown;
  };

  if (
    typeof requirements !== "string" ||
    requirements.trim().length === 0
  ) {
    return NextResponse.json(
      { error: "requirements must be a non-empty string." },
      { status: 400 }
    );
  }
  if (requirements.length > 4000) {
    return NextResponse.json(
      { error: "requirements must be 4000 characters or fewer." },
      { status: 400 }
    );
  }
  if (
    !Array.isArray(columns) ||
    columns.length === 0 ||
    columns.length > 100 ||
    columns.some((c) => typeof c !== "string" || c.trim() === "")
  ) {
    return NextResponse.json(
      { error: "columns must be a non-empty array of up to 100 column names." },
      { status: 400 }
    );
  }
  if (!Array.isArray(sampleRows) || sampleRows.length > 10) {
    return NextResponse.json(
      { error: "sampleRows must be an array of at most 10 rows." },
      { status: 400 }
    );
  }
  if (
    typeof rowCount !== "number" ||
    !Number.isFinite(rowCount) ||
    rowCount < 0
  ) {
    return NextResponse.json(
      { error: "rowCount must be a number >= 0." },
      { status: 400 }
    );
  }

  // Bring-your-own-key: a key sent with the request wins over the server key.
  // The key is never logged or stored server-side.
  const bodyApiKey =
    typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const apiKey = bodyApiKey || process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "No API key is set. Add your free Groq API key in the website settings (sidebar), or set GROQ_API_KEY on the server.",
      },
      { status: 500 }
    );
  }

  const userMessage = JSON.stringify({
    columns,
    rowCount,
    sampleRows,
    requirements: requirements.trim(),
  });

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
        temperature: 0.2,
        max_tokens: 2048,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
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
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed?.error?.message) message = parsed.error.message;
    } catch {
      if (text) message = text.slice(0, 500);
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const data = (await upstream.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
  } | null;
  const content = data?.choices?.[0]?.message?.content ?? "";
  if (!content) {
    return NextResponse.json(
      { error: "The AI service returned an empty response." },
      { status: 502 }
    );
  }

  let parsed: unknown;
  try {
    parsed = extractJson(content);
  } catch {
    return NextResponse.json(
      { error: "The AI did not return a valid plan (bad JSON)." },
      { status: 502 }
    );
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.plan)) {
    return NextResponse.json(
      { error: "The AI plan is missing a 'plan' array." },
      { status: 502 }
    );
  }

  // Server-side validation: known ops + a reason on every step.
  for (let i = 0; i < parsed.plan.length; i++) {
    const step = parsed.plan[i] as Record<string, unknown>;
    if (!isRecord(step) || typeof step.op !== "string") {
      return NextResponse.json(
        { error: `The AI plan is invalid at step ${i + 1} (missing "op").` },
        { status: 502 }
      );
    }
    if (!KNOWN_OPS.has(step.op)) {
      return NextResponse.json(
        { error: `The AI plan uses unknown operation "${step.op}" at step ${i + 1}.` },
        { status: 502 }
      );
    }
    if (typeof step.reason !== "string" || step.reason.trim() === "") {
      return NextResponse.json(
        { error: `The AI plan is invalid at step ${i + 1} (missing "reason").` },
        { status: 502 }
      );
    }
  }

  // Dry-run the plan against the sample rows: catches bad columns/params
  // before the plan ever reaches the user.
  const sample = (sampleRows as Row[]).filter(isRecord) as Row[];
  if (sample.length > 0) {
    try {
      runPlan(sample, parsed.plan as PlanStep[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Plan failed validation.";
      return NextResponse.json(
        { error: `The AI plan failed validation: ${msg}` },
        { status: 502 }
      );
    }
  }

  const result: PlanResponse = {
    plan: parsed.plan as PlanStep[],
    summary:
      typeof parsed.summary === "string" ? parsed.summary : "",
    warnings: Array.isArray(parsed.warnings)
      ? (parsed.warnings as unknown[]).filter(
          (w): w is string => typeof w === "string"
        )
      : [],
  };
  return NextResponse.json(result);
}

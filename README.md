# SanRemes Web

A clean, Claude/ChatGPT-style chat UI where you pick a **role** — a specialist AI
agent — and chat with it.

Roles included:

- **Data Engineer** — Databricks, PySpark, SQL, AWS Glue, Airflow, Snowflake,
  Delta Lake, ETL/ELT design, pipeline debugging, data modelling, data quality
- **Full-Stack Developer** — React/Next.js, Node.js, Python/FastAPI, REST APIs,
  databases, auth, deployment
- **QA / Testing Engineer** — test strategy, test cases, Playwright/Selenium
  automation, bug reports, edge cases
- **DevOps Engineer** — CI/CD, Docker, AWS, infrastructure, monitoring,
  troubleshooting deploys
- **Digital Marketing** — SEO, Google/Meta ads, content, GA4 analytics, funnels

Each role has its own expert system prompt, starter suggestions, and its own
conversation (kept per role in the browser's localStorage).

## Stack

Next.js (App Router) + TypeScript + Tailwind CSS v4. Chat runs through the
Groq OpenAI-compatible API (`openai/gpt-oss-120b`) via server-side API routes.
No API key is stored anywhere in the code.

## Run locally

```bash
npm install
```

Create a `.env.local` file in the project root (see `.env.local.example`):

```bash
GROQ_API_KEY=your-groq-api-key
```

Get a free key at https://console.groq.com (free tier, no card required).

Then:

```bash
npm run dev
```

Open http://localhost:3000.

## Bring your own key (no server key needed)

Visitors can add their own free Groq API key in the website itself — in the
sidebar, under **Groq API key**. The key is stored only in that browser's
localStorage and sent with each chat request; the server never stores or logs
it. A key sent with a request takes priority over the server's
`GROQ_API_KEY`, which acts as a fallback. Get a free key at
https://console.groq.com/keys (free tier, no card required).

## Auto-DE Studio

A separate page at `/auto-de` (linked from the chat sidebar). Upload a CSV or
Excel file, describe what you need in plain English, review the plan the AI
makes, approve it, and download the cleaned CSV.

Flow: **1. Upload → 2. Requirements → 3. Plan → 4. Result.**

- Files are parsed in the browser (papaparse for CSV, xlsx for Excel) and
  **never uploaded** — only the column names, a few sample rows, and your
  requirements are sent to the plan endpoint.
- The AI only produces a JSON plan of steps. It never writes code that runs.
- A deterministic engine (`lib/transform.ts`) executes the plan locally.
  Supported operations (12): drop_duplicates, drop_missing, fill_missing,
  trim, change_case, rename_column, drop_column, convert_type (number/date),
  filter_rows, sort, group_aggregate, replace_values. Every step is validated
  before it runs — an unknown operation, a missing column, or bad parameters
  stops with a clear error naming the step.
- The plan endpoint is `POST /api/auto-de/plan` — body
  `{ columns, sampleRows (max 10), rowCount, requirements (max 4000 chars), apiKey? }`.
  It uses the request's `apiKey` first (the browser-stored Groq key), else
  the server's `GROQ_API_KEY`. The plan is validated server-side and dry-run
  against the sample rows before it is returned.

## API

- `GET /api/roles` — public role info only (id, name, tagline, description,
  initials, color, suggestions). System prompts are never exposed.
- `POST /api/chat` — body
  `{ role: string, messages: [{ role: "user" | "assistant", content: string }], stream?: boolean, apiKey?: string }`.
  An `apiKey` sent with the request (the visitor's own Groq key) is used
  first; otherwise the server's `GROQ_API_KEY` is used. The key is never
  logged or stored.
  Streams Server-Sent Events by default (`data: {"content": "..."}` lines,
  ending with `data: [DONE]`). With `stream: false` it returns JSON
  `{ reply: string }`. Unknown role → 400. Missing server key → clean 500.
  Upstream failure → 502.

## Deploy on Vercel

1. Push this folder to a GitHub repo (or import it directly in Vercel).
2. In Vercel: **Add New → Project → Import** the repo.
3. Framework preset: **Next.js** (auto-detected).
4. Add the environment variable in **Project Settings → Environment Variables**:
   - Name: `GROQ_API_KEY`
   - Value: your Groq API key
   - Scope: Production (and Preview if you want previews to work too)
5. Deploy. No other settings are needed — the build command is `next build`
   and the output is the standard Next.js server.

Notes:

- The app is a standard Next.js server app (not static export) because chat
  is served by API routes.
- Never commit `.env.local` — it is gitignored. The key only ever lives in
  the Vercel dashboard / your local `.env.local`.
- Groq's free tier covers casual testing; if you hit rate limits, check your
  usage at https://console.groq.com.

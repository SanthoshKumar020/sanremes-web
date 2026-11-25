// Shared helpers for the Website Builder (Phase 1 of the Autonomous AI
// Company OS): the deterministic test gate, file validation, and cost
// estimation. The test gate runs entirely server-side with no LLM — it is
// the ground-truth check the build → test → fix → deploy loop is gated on.
// The LLM only ever writes files; nothing generated is executed here.

export interface SiteFile {
  path: string;
  content: string;
}

export interface GateCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface GateResult {
  passed: boolean;
  failures: string[];
  checks: GateCheck[];
}

// gpt-oss-120b list prices on Groq (USD per 1M tokens). Estimates only.
export const GROQ_INPUT_RATE_PER_M = 0.15;
export const GROQ_OUTPUT_RATE_PER_M = 0.6;

/** Rough token estimate: ~4 characters per token. */
export function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

/** Estimated USD cost of one Groq call from its input/output sizes. */
export function estimateCostUsd(
  inputChars: number,
  outputChars: number
): number {
  return (
    (estimateTokens(inputChars) / 1_000_000) * GROQ_INPUT_RATE_PER_M +
    (estimateTokens(outputChars) / 1_000_000) * GROQ_OUTPUT_RATE_PER_M
  );
}

const MAX_FILES = 6;
const MAX_TOTAL_CHARS = 300_000;
const ALLOWED_EXTENSIONS = new Set([".html", ".css", ".js"]);

/**
 * Strictly validate a files array the Developer step returned.
 * Returns the cleaned files, or an error string.
 */
export function validateFiles(
  parsed: unknown
): { files: SiteFile[] } | { error: string } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "The AI response is not a JSON object." };
  }
  const filesRaw = (parsed as Record<string, unknown>).files;
  if (!Array.isArray(filesRaw) || filesRaw.length === 0) {
    return { error: "The AI response has no 'files' array." };
  }
  if (filesRaw.length > MAX_FILES) {
    return {
      error: `The AI returned ${filesRaw.length} files (max ${MAX_FILES}).`,
    };
  }
  const files: SiteFile[] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  for (let i = 0; i < filesRaw.length; i++) {
    const f = filesRaw[i] as Record<string, unknown>;
    if (
      !f ||
      typeof f !== "object" ||
      typeof f.path !== "string" ||
      typeof f.content !== "string"
    ) {
      return { error: `File ${i + 1} is missing "path" or "content".` };
    }
    const path = f.path.trim().replace(/\\/g, "/");
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("..") ||
      path.includes("\0")
    ) {
      return { error: `File ${i + 1} has an unsafe path: "${f.path}".` };
    }
    const dot = path.lastIndexOf(".");
    const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return {
        error: `File "${path}" has an unsupported extension (only .html, .css, .js).`,
      };
    }
    if (seen.has(path)) {
      return { error: `Duplicate file path: "${path}".` };
    }
    seen.add(path);
    if (f.content.trim().length === 0) {
      return { error: `File "${path}" is empty.` };
    }
    totalChars += f.content.length;
    files.push({ path, content: f.content });
  }
  if (totalChars > MAX_TOTAL_CHARS) {
    return {
      error: `The site is ${totalChars.toLocaleString()} characters (max ${MAX_TOTAL_CHARS.toLocaleString()}).`,
    };
  }
  if (!seen.has("index.html")) {
    return { error: "The site must include an index.html file." };
  }
  return { files };
}

/** Visible text of an HTML document: scripts, styles and tags stripped. */
export function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const PLACEHOLDER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\blorem ipsum\b/i, label: "lorem ipsum text" },
  { pattern: /\bTODO\b/, label: "TODO marker" },
  { pattern: /\bFIXME\b/, label: "FIXME marker" },
  { pattern: /\bcoming soon\b/i, label: "'coming soon' text" },
  { pattern: /\bsample text\b/i, label: "'sample text'" },
  { pattern: /\byour text here\b/i, label: "'your text here'" },
  { pattern: /\bxxx+\b/i, label: "xxx filler" },
];

const STOPWORDS = new Set([
  "the",
  "and",
  "with",
  "for",
  "our",
  "your",
  "you",
  "page",
  "section",
  "site",
  "website",
  "that",
  "this",
  "from",
  "into",
  "about",
  "more",
  "info",
  "list",
  "form",
  "area",
  "part",
]);

/** Words worth checking for a required section: >= 4 letters, not a stopword. */
function sectionKeywords(section: string): string[] {
  return Array.from(
    new Set(
      section
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
    )
  );
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i + 1) : "";
}

/** Resolve a relative reference (from a file) to a path in the file set. */
function resolveRef(fromPath: string, ref: string): string {
  const base = dirOf(fromPath);
  const parts = (base + ref).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

/**
 * Deterministic test gate. Checks, with no LLM involved:
 *  1. index.html exists and has valid basic structure
 *  2. a non-empty <title> is present
 *  3. a viewport meta tag is present (responsive)
 *  4. no placeholder / lorem ipsum / TODO text in visible copy
 *  5. every internal link and asset reference resolves within the file set
 *     (including #anchor targets)
 *  6. every section the brief asked for is present (keyword check)
 */
export function runTestGate(
  files: SiteFile[],
  requiredSections: string[]
): GateResult {
  const checks: GateCheck[] = [];
  const failures: string[] = [];
  const byPath = new Map(files.map((f) => [f.path, f.content]));

  const check = (name: string, passed: boolean, detail: string) => {
    checks.push({ name, passed, detail });
    if (!passed) failures.push(`${name}: ${detail}`);
  };

  const index = byPath.get("index.html");
  if (index === undefined) {
    check("index.html exists", false, "No index.html file in the site.");
    return { passed: false, failures, checks };
  }
  check("index.html exists", true, "index.html found.");

  const html = index;
  const lower = html.toLowerCase();
  const structureProblems: string[] = [];
  if (!/<!doctype html>/i.test(html)) structureProblems.push("missing <!doctype html>");
  if (!/<html[\s>]/.test(lower)) structureProblems.push("missing <html>");
  if (!/<head[\s>]/.test(lower)) structureProblems.push("missing <head>");
  if (!/<body[\s>]/.test(lower)) structureProblems.push("missing <body>");
  if (!/<\/body\s*>/.test(lower)) structureProblems.push("missing </body>");
  if (!/<\/html\s*>/.test(lower)) structureProblems.push("missing </html>");
  check(
    "Valid HTML structure",
    structureProblems.length === 0,
    structureProblems.length === 0
      ? "doctype, html, head, body and closing tags present."
      : structureProblems.join("; ")
  );

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";
  check(
    "<title> present",
    title.length > 0,
    title.length > 0 ? `Title: "${title.slice(0, 80)}"` : "No <title> or it is empty."
  );

  check(
    "Viewport meta present",
    /<meta[^>]+name=["']viewport["']/i.test(html),
    /<meta[^>]+name=["']viewport["']/i.test(html)
      ? "Viewport meta tag found (mobile-friendly)."
      : "No <meta name=\"viewport\"> — the page will not scale on mobile."
  );

  // Placeholder text, checked on visible copy only (so a form input's
  // placeholder="Your name" attribute does not trip it).
  const text = files
    .filter((f) => f.path.endsWith(".html"))
    .map((f) => visibleText(f.content))
    .join(" ");
  const placeholderHits = PLACEHOLDER_PATTERNS.filter((p) =>
    p.pattern.test(text)
  ).map((p) => p.label);
  check(
    "No placeholder text",
    placeholderHits.length === 0,
    placeholderHits.length === 0
      ? "No lorem ipsum, TODO or filler text found."
      : `Found: ${placeholderHits.join(", ")}.`
  );

  // Internal links and asset references must resolve within the file set.
  const broken: string[] = [];
  const idCache = new Map<string, Set<string>>();
  const idsOf = (path: string): Set<string> => {
    let ids = idCache.get(path);
    if (!ids) {
      ids = new Set<string>();
      const content = byPath.get(path) ?? "";
      for (const m of content.matchAll(/id=["']([^"']+)["']/gi)) {
        ids.add(m[1]);
      }
      idCache.set(path, ids);
    }
    return ids;
  };

  for (const file of files.filter((f) => f.path.endsWith(".html"))) {
    const refs = new Set<string>();
    for (const m of file.content.matchAll(
      /(?:href|src)\s*=\s*["']([^"']+)["']/gi
    )) {
      refs.add(m[1]);
    }
    for (const ref of refs) {
      if (!ref) continue;
      if (
        ref.startsWith("http://") ||
        ref.startsWith("https://") ||
        ref.startsWith("//") ||
        ref.startsWith("mailto:") ||
        ref.startsWith("tel:") ||
        ref.startsWith("data:")
      ) {
        continue; // External links are out of scope for this gate.
      }
      const [pathPart, fragment] = ref.split("#");
      if (!pathPart) {
        // Same-page anchor: #id must exist in this file.
        if (fragment && !idsOf(file.path).has(fragment)) {
          broken.push(`${file.path}: anchor "#${fragment}" has no matching id.`);
        }
        continue;
      }
      const target = resolveRef(file.path, pathPart.split("?")[0]);
      if (!byPath.has(target)) {
        broken.push(`${file.path}: "${ref}" points to missing file "${target}".`);
        continue;
      }
      if (fragment && target.endsWith(".html") && !idsOf(target).has(fragment)) {
        broken.push(
          `${file.path}: anchor "#${fragment}" has no matching id in "${target}".`
        );
      }
    }
  }
  check(
    "Internal links resolve",
    broken.length === 0,
    broken.length === 0
      ? "All internal links and asset references resolve."
      : broken.join(" ")
  );

  // Required sections from the brief (keyword check on visible text).
  const missingSections: string[] = [];
  const lowerText = ` ${text.toLowerCase()} `;
  for (const section of requiredSections) {
    const keywords = sectionKeywords(section);
    if (keywords.length === 0) continue;
    // Word-boundary match, so "port" does not match "portfolio".
    const found = keywords.some((kw) =>
      new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
        lowerText
      )
    );
    if (!found) missingSections.push(`"${section}"`);
  }
  check(
    "Required sections present",
    missingSections.length === 0,
    missingSections.length === 0
      ? requiredSections.length > 0
        ? `${requiredSections.length} requested section(s) found.`
        : "No sections were requested."
      : `Missing sections: ${missingSections.join(", ")}.`
  );

  return { passed: failures.length === 0, failures, checks };
}

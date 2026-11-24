"use client";

import { useRef, useState } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  runPlan,
  columnStats,
  describeStep,
  OP_LABELS,
} from "@/lib/transform";
import type { PlanStep, Row } from "@/lib/transform";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 100000;
const PREVIEW_ROWS = 8;
const KEY_STORAGE = "sanremes-groq-key";

const EXAMPLE_REQUIREMENTS = [
  "Remove duplicate rows and empty rows",
  "Standardize all dates to YYYY-MM-DD and fill missing city with Unknown",
  "Total revenue by region, sorted highest first",
];

interface PlanResponse {
  plan: PlanStep[];
  summary: string;
  warnings: string[];
}

/* ---------- helpers ---------- */

function dedupeColumns(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw, i) => {
    const base = raw && raw.trim() ? raw.trim() : `column_${i + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base} (${count + 1})`;
  });
}

/** Normalize raw parsed rows to uniform string rows with deduped columns. */
function normalizeRows(
  rawRows: Record<string, unknown>[],
  rawColumns: string[]
): { columns: string[]; rows: Row[] } {
  const columns = dedupeColumns(rawColumns.map((c) => String(c)));
  const rows: Row[] = [];
  for (const raw of rawRows) {
    const out: Row = {};
    columns.forEach((col, i) => {
      const v = raw[rawColumns[i]];
      out[col] = v === undefined || v === null ? "" : String(v);
    });
    // Skip rows that are entirely empty.
    if (Object.values(out).some((v) => v.trim() !== "")) rows.push(out);
  }
  return { columns, rows };
}

function fileBaseName(name: string): string {
  return name.replace(/\.[^.]+$/, "") || "data";
}

/* ---------- small components ---------- */

function StepIndicator({ step }: { step: number }) {
  const steps = ["Upload", "Requirements", "Plan", "Result"];
  return (
    <ol className="flex items-center gap-2">
      {steps.map((label, i) => {
        const n = i + 1;
        const state =
          n < step ? "done" : n === step ? "current" : "upcoming";
        return (
          <li key={label} className="flex flex-1 items-center gap-2 last:flex-none">
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                state === "current"
                  ? "bg-[#1f1e1c] text-white"
                  : state === "done"
                    ? "bg-green-700 text-white"
                    : "bg-[#e6e3dd] text-[#6f6d68]"
              }`}
            >
              {state === "done" ? "✓" : n}
            </span>
            <span
              className={`hidden text-sm font-medium sm:block ${
                state === "current"
                  ? "text-[#1f1e1c]"
                  : "text-[#6f6d68]"
              }`}
            >
              {label}
            </span>
            {n < steps.length && (
              <span className="h-px flex-1 bg-[#e6e3dd]" aria-hidden="true" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function PreviewTable({
  columns,
  rows,
  caption,
}: {
  columns: string[];
  rows: Row[];
  caption: string;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-[#6f6d68]">{caption}</p>
      <div className="overflow-x-auto rounded-xl border border-[#e6e3dd] bg-white">
        <table className="w-full border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-[#e6e3dd] bg-[#f4f3f0]">
              {columns.map((c) => (
                <th
                  key={c}
                  className="max-w-48 truncate px-3 py-2 font-semibold"
                  title={c}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={i}
                className="border-b border-[#f0eee9] last:border-b-0"
              >
                {columns.map((c) => (
                  <td
                    key={c}
                    className="max-w-48 truncate px-3 py-2 text-[#3d3b38]"
                    title={row[c] ?? ""}
                  >
                    {row[c] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------- page ---------- */

export default function AutoDE() {
  const [step, setStep] = useState(1);
  const [fileName, setFileName] = useState("");
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [requirements, setRequirements] = useState("");
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [resultRows, setResultRows] = useState<Row[] | null>(null);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadFile = (file: File) => {
    setFileError(null);
    const lower = file.name.toLowerCase();
    const isCsv = lower.endsWith(".csv");
    const isXlsx = lower.endsWith(".xlsx") || lower.endsWith(".xls");
    if (!isCsv && !isXlsx) {
      setFileError("Please upload a .csv or .xlsx file.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setFileError("That file is over 10 MB. Please use a smaller file.");
      return;
    }

    const finish = (parsed: { columns: string[]; rows: Row[] }) => {
      if (parsed.rows.length === 0) {
        setFileError("No data rows found in this file.");
        return;
      }
      if (parsed.rows.length > MAX_ROWS) {
        setFileError(
          `This file has ${parsed.rows.length.toLocaleString()} rows — the limit is ${MAX_ROWS.toLocaleString()}. Please use a smaller file.`
        );
        return;
      }
      setFileName(file.name);
      setColumns(parsed.columns);
      setRows(parsed.rows);
      setPlan(null);
      setPlanError(null);
      setRunError(null);
      setResultRows(null);
      setStep(2);
    };

    if (isCsv) {
      Papa.parse<Row>(file, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: false,
        complete: (results) => {
          if (results.errors.length > 0) {
            setFileError(
              `Could not read this CSV: ${results.errors[0].message}`
            );
            return;
          }
          const fields = results.meta.fields ?? [];
          finish(normalizeRows(results.data as Row[], fields));
        },
        error: (err) => setFileError(`Could not read this CSV: ${err.message}`),
      });
      return;
    }

    // Excel: first sheet only.
    file
      .arrayBuffer()
      .then((buf) => {
        const wb = XLSX.read(buf, { type: "array" });
        const sheetName = wb.SheetNames[0];
        if (!sheetName) {
          setFileError("No sheets found in this workbook.");
          return;
        }
        const ws = wb.Sheets[sheetName];
        const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
          defval: "",
        });
        const rawColumns: string[] = [];
        for (const r of raw) {
          for (const k of Object.keys(r)) {
            if (!rawColumns.includes(k)) rawColumns.push(k);
          }
        }
        finish(normalizeRows(raw, rawColumns));
      })
      .catch(() =>
        setFileError("Could not read this Excel file. Is it a valid .xlsx?")
      );
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) loadFile(file);
  };

  const generatePlan = async () => {
    if (!requirements.trim() || columns.length === 0) return;
    setPlanLoading(true);
    setPlanError(null);
    setRunError(null);
    let storedKey = "";
    try {
      storedKey = localStorage.getItem(KEY_STORAGE) ?? "";
      setHasStoredKey(storedKey.trim() !== "");
    } catch {
      // No stored key; the server key is the fallback.
    }
    try {
      const res = await fetch("/api/auto-de/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          columns,
          sampleRows: rows.slice(0, 5),
          rowCount: rows.length,
          requirements: requirements.trim(),
          ...(storedKey.trim() ? { apiKey: storedKey.trim() } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        plan?: PlanStep[];
        summary?: string;
        warnings?: string[];
      };
      if (!res.ok) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      if (!Array.isArray(data.plan)) {
        throw new Error("The AI did not return a valid plan.");
      }
      setPlan({
        plan: data.plan,
        summary: data.summary ?? "",
        warnings: data.warnings ?? [],
      });
      setStep(3);
    } catch (err) {
      setPlanError(
        err instanceof Error ? err.message : "Could not generate a plan."
      );
    } finally {
      setPlanLoading(false);
    }
  };

  const runApprovedPlan = () => {
    if (!plan) return;
    try {
      const out = runPlan(rows, plan.plan);
      setResultRows(out);
      setRunError(null);
      setStep(4);
    } catch (err) {
      setRunError(
        err instanceof Error ? err.message : "The plan could not run."
      );
    }
  };

  const downloadCleaned = () => {
    if (!resultRows) return;
    const resultColumns =
      resultRows.length > 0 ? Object.keys(resultRows[0]) : columns;
    const csv = Papa.unparse(resultRows, { columns: resultColumns });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileBaseName(fileName)}-cleaned.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const startOver = () => {
    setStep(1);
    setFileName("");
    setColumns([]);
    setRows([]);
    setFileError(null);
    setRequirements("");
    setPlan(null);
    setPlanError(null);
    setRunError(null);
    setResultRows(null);
  };

  const beforeStats = columnStats(rows);
  const afterStats = resultRows ? columnStats(resultRows) : null;
  const resultColumns =
    resultRows && resultRows.length > 0
      ? Object.keys(resultRows[0])
      : columns;

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
            Auto-DE Studio
          </h1>
          <p className="mt-1 text-sm leading-relaxed text-[#6f6d68]">
            Upload a CSV or Excel file, describe what you need in plain
            English, approve the plan, and download the cleaned file. Your
            file is parsed in your browser and never uploaded anywhere.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <StepIndicator step={step} />

        {/* Step 1 — Upload */}
        {step === 1 && (
          <section className="mt-6">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") fileInputRef.current?.click();
              }}
              className={`cursor-pointer rounded-2xl border-2 border-dashed bg-white px-6 py-12 text-center transition ${
                dragging
                  ? "border-[#1f1e1c] bg-[#f4f3f0]"
                  : "border-[#d8d4cc] hover:border-[#b8b4ac]"
              }`}
            >
              <p className="text-lg font-semibold">
                Drop your file here, or click to choose one
              </p>
              <p className="mt-2 text-sm text-[#6f6d68]">
                CSV or Excel (.csv, .xlsx, .xls) · up to 10 MB · up to 100,000
                rows
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) loadFile(f);
                  e.target.value = "";
                }}
              />
            </div>
            {fileError && (
              <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-[#b3261e]">
                {fileError}
              </p>
            )}
          </section>
        )}

        {/* Step 2 — Requirements */}
        {step === 2 && (
          <section className="mt-6">
            <div className="rounded-2xl border border-[#e6e3dd] bg-white p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">
                  {fileName}
                </h2>
                <span className="text-sm text-[#6f6d68]">
                  {rows.length.toLocaleString()} rows · {columns.length}{" "}
                  columns
                </span>
              </div>
              <p className="mt-2 text-sm text-[#6f6d68]">
                Columns:{" "}
                <span className="font-mono text-[13px] text-[#3d3b38]">
                  {columns.join(", ")}
                </span>
              </p>
              <div className="mt-4">
                <PreviewTable
                  columns={columns}
                  rows={rows.slice(0, PREVIEW_ROWS)}
                  caption={`Preview — first ${Math.min(PREVIEW_ROWS, rows.length)} rows`}
                />
              </div>
            </div>

            <div className="mt-5 rounded-2xl border border-[#e6e3dd] bg-white p-5">
              <label
                htmlFor="requirements"
                className="text-sm font-semibold"
              >
                What should be done with this data?
              </label>
              <textarea
                id="requirements"
                rows={4}
                value={requirements}
                onChange={(e) => setRequirements(e.target.value)}
                placeholder="Describe the cleaning and transformation in plain English — e.g. remove duplicate orders, fix the date format, total revenue by region…"
                className="mt-2 w-full resize-y rounded-xl border border-[#e6e3dd] bg-[#faf9f7] px-3 py-2.5 text-[15px] leading-relaxed outline-none placeholder:text-[#9a978f] focus:ring-2 focus:ring-[#1f1e1c]/10"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                {EXAMPLE_REQUIREMENTS.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => setRequirements(ex)}
                    className="rounded-full border border-[#e6e3dd] bg-white px-3.5 py-1.5 text-left text-[13px] shadow-sm transition hover:bg-[#f4f3f0]"
                  >
                    {ex}
                  </button>
                ))}
              </div>
              {planError && (
                <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-[#b3261e]">
                  {planError}
                </p>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void generatePlan()}
                  disabled={!requirements.trim() || planLoading}
                  className="rounded-full bg-[#1f1e1c] px-5 py-2.5 text-sm font-medium text-white transition hover:bg-black disabled:opacity-40"
                >
                  {planLoading ? "Making your plan…" : "Generate plan"}
                </button>
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="rounded-full border border-[#e6e3dd] bg-white px-4 py-2.5 text-sm font-medium shadow-sm transition hover:bg-[#f4f3f0]"
                >
                  Change file
                </button>
              </div>
              {!hasStoredKey && (
                <p className="mt-3 text-xs leading-relaxed text-[#9a978f]">
                  Tip: add your free Groq key in the chat sidebar — it stays
                  in your browser.
                </p>
              )}
            </div>
          </section>
        )}

        {/* Step 3 — Plan */}
        {step === 3 && plan && (
          <section className="mt-6">
            <div className="rounded-2xl border border-[#e6e3dd] bg-white p-5">
              <h2 className="text-lg font-semibold">Your plan</h2>
              {plan.summary && (
                <p className="mt-2 text-[15px] leading-relaxed text-[#3d3b38]">
                  {plan.summary}
                </p>
              )}
              {plan.warnings.length > 0 && (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                  <p className="text-sm font-semibold text-amber-800">
                    Things to check
                  </p>
                  <ul className="mt-1 list-disc pl-5 text-sm leading-relaxed text-amber-800">
                    {plan.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              <ol className="mt-4 space-y-3">
                {plan.plan.map((s, i) => (
                  <li
                    key={i}
                    className="flex gap-3 rounded-xl border border-[#e6e3dd] bg-[#faf9f7] px-4 py-3"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1f1e1c] text-xs font-bold text-white">
                      {i + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">
                        {OP_LABELS[s.op]} — {describeStep(s)}
                      </p>
                      {s.reason && (
                        <p className="mt-0.5 text-sm leading-relaxed text-[#6f6d68]">
                          {s.reason}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              {plan.plan.length === 0 && (
                <p className="mt-4 text-sm text-[#6f6d68]">
                  The AI returned an empty plan — nothing to do. Try wording
                  your requirements differently.
                </p>
              )}
              {runError && (
                <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-[#b3261e]">
                  {runError}
                </p>
              )}
              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={runApprovedPlan}
                  disabled={plan.plan.length === 0}
                  className="rounded-full bg-[#1f1e1c] px-5 py-2.5 text-sm font-medium text-white transition hover:bg-black disabled:opacity-40"
                >
                  Approve &amp; run
                </button>
                <button
                  type="button"
                  onClick={() => void generatePlan()}
                  disabled={planLoading}
                  className="rounded-full border border-[#e6e3dd] bg-white px-4 py-2.5 text-sm font-medium shadow-sm transition hover:bg-[#f4f3f0] disabled:opacity-50"
                >
                  {planLoading ? "Regenerating…" : "Regenerate plan"}
                </button>
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="rounded-full border border-[#e6e3dd] bg-white px-4 py-2.5 text-sm font-medium shadow-sm transition hover:bg-[#f4f3f0]"
                >
                  Edit requirements
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Step 4 — Result */}
        {step === 4 && resultRows && afterStats && (
          <section className="mt-6 space-y-5">
            <div className="rounded-2xl border border-[#e6e3dd] bg-white p-5">
              <h2 className="text-lg font-semibold">Done</h2>
              <p className="mt-2 text-[15px] leading-relaxed">
                <span className="font-semibold">
                  {beforeStats.rowCount.toLocaleString()} →{" "}
                  {afterStats.rowCount.toLocaleString()} rows
                </span>
                <span className="text-[#6f6d68]">
                  {" "}
                  · {resultColumns.length} columns in the result
                </span>
              </p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full border-collapse text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-[#e6e3dd] text-[#6f6d68]">
                      <th className="px-3 py-2 font-semibold">Column</th>
                      <th className="px-3 py-2 font-semibold">
                        Missing before
                      </th>
                      <th className="px-3 py-2 font-semibold">
                        Missing after
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {resultColumns.slice(0, 8).map((c) => (
                      <tr
                        key={c}
                        className="border-b border-[#f0eee9] last:border-b-0"
                      >
                        <td className="max-w-48 truncate px-3 py-2 font-medium">
                          {c}
                        </td>
                        <td className="px-3 py-2">
                          {beforeStats.columns[c]?.nullCount ?? "—"}
                        </td>
                        <td className="px-3 py-2">
                          {afterStats.columns[c]?.nullCount ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {resultColumns.length > 8 && (
                  <p className="mt-2 text-xs text-[#9a978f]">
                    Showing the first 8 of {resultColumns.length} columns.
                  </p>
                )}
              </div>
            </div>

            <PreviewTable
              columns={resultColumns}
              rows={resultRows.slice(0, PREVIEW_ROWS)}
              caption={`Result preview — first ${Math.min(PREVIEW_ROWS, resultRows.length)} rows`}
            />

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={downloadCleaned}
                className="rounded-full bg-[#1f1e1c] px-5 py-2.5 text-sm font-medium text-white transition hover:bg-black"
              >
                Download cleaned CSV
              </button>
              <button
                type="button"
                onClick={startOver}
                className="rounded-full border border-[#e6e3dd] bg-white px-4 py-2.5 text-sm font-medium shadow-sm transition hover:bg-[#f4f3f0]"
              >
                Start over
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

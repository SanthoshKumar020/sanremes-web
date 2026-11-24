// Deterministic data-cleaning engine for Auto-DE Studio.
//
// Safety rule: the AI never writes code that runs. It only produces a JSON
// plan made of the operations below, and this module executes them. Every
// operation is a pure function over rows (all values are strings; an empty
// string — or whitespace-only — counts as missing).

export type Row = Record<string, string>;

export type AggregationFn = "sum" | "mean" | "count" | "min" | "max";

export interface Aggregation {
  column: string;
  fn: AggregationFn;
  as: string;
}

export type PlanStep =
  | { op: "drop_duplicates"; columns?: string[]; reason?: string }
  | { op: "drop_missing"; column: string; reason?: string }
  | { op: "fill_missing"; column: string; value: string; reason?: string }
  | { op: "trim"; column: string; reason?: string }
  | {
      op: "change_case";
      column: string;
      mode: "lower" | "upper" | "title";
      reason?: string;
    }
  | { op: "rename_column"; from: string; to: string; reason?: string }
  | { op: "drop_column"; column: string; reason?: string }
  | {
      op: "convert_type";
      column: string;
      to: "number" | "date";
      reason?: string;
    }
  | {
      op: "filter_rows";
      column: string;
      operator: "equals" | "not_equals" | "greater_than" | "less_than" | "contains";
      value: string;
      reason?: string;
    }
  | { op: "sort"; column: string; direction: "asc" | "desc"; reason?: string }
  | {
      op: "group_aggregate";
      groupBy: string[];
      aggregations: Aggregation[];
      reason?: string;
    }
  | {
      op: "replace_values";
      column: string;
      from: string;
      to: string;
      reason?: string;
    };

export const KNOWN_OPS: PlanStep["op"][] = [
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
];

/** Plain-words label for each operation (used by the plan UI). */
export const OP_LABELS: Record<PlanStep["op"], string> = {
  drop_duplicates: "Remove duplicate rows",
  drop_missing: "Remove rows with missing values",
  fill_missing: "Fill missing values",
  trim: "Trim whitespace",
  change_case: "Change text case",
  rename_column: "Rename column",
  drop_column: "Remove column",
  convert_type: "Convert column type",
  filter_rows: "Filter rows",
  sort: "Sort rows",
  group_aggregate: "Group and aggregate",
  replace_values: "Replace values",
};

/** One-line plain-words description of a step, e.g. `Fill empty "city" with "Unknown"`. */
export function describeStep(step: PlanStep): string {
  switch (step.op) {
    case "drop_duplicates":
      return step.columns && step.columns.length > 0
        ? `Remove rows that duplicate on ${step.columns.map((c) => `"${c}"`).join(", ")}`
        : "Remove rows that are exact duplicates";
    case "drop_missing":
      return `Remove rows where "${step.column}" is empty`;
    case "fill_missing":
      return `Fill empty "${step.column}" with "${step.value}"`;
    case "trim":
      return `Trim whitespace in "${step.column}"`;
    case "change_case":
      return `Change "${step.column}" to ${step.mode} case`;
    case "rename_column":
      return `Rename "${step.from}" to "${step.to}"`;
    case "drop_column":
      return `Remove the "${step.column}" column`;
    case "convert_type":
      return step.to === "date"
        ? `Convert "${step.column}" to dates (YYYY-MM-DD)`
        : `Convert "${step.column}" to numbers`;
    case "filter_rows":
      return `Keep rows where "${step.column}" ${step.operator.replace("_", " ")} "${step.value}"`;
    case "sort":
      return `Sort by "${step.column}" (${step.direction === "asc" ? "lowest first" : "highest first"})`;
    case "group_aggregate": {
      const aggs = step.aggregations
        .map((a) => `${a.fn} of "${a.column}" as "${a.as}"`)
        .join(", ");
      const by =
        step.groupBy.length > 0
          ? ` by ${step.groupBy.map((c) => `"${c}"`).join(", ")}`
          : "";
      return `Group rows${by} and calculate ${aggs}`;
    }
    case "replace_values":
      return `Replace "${step.from}" with "${step.to}" in "${step.column}"`;
  }
}

/* ---------- helpers ---------- */

export function isMissing(value: string | undefined | null): boolean {
  return value === undefined || value === null || String(value).trim() === "";
}

function toNumber(value: string): number | null {
  if (isMissing(value)) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

function parseNumberLoose(value: string): number | null {
  if (isMissing(value)) return null;
  // Strip commas, spaces and common currency symbols, then parse.
  const cleaned = value.replace(/[,\s₹$€£¥]/g, "").trim();
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function isValidDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

function formatDate(y: number, m: number, d: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(m)}-${p(d)}`;
}

/**
 * Parse common date formats into YYYY-MM-DD. Unparseable values return "".
 * For ambiguous DD/MM vs MM/DD (both parts <= 12) we assume DD/MM, the
 * convention used in India.
 */
export function parseDateLoose(value: string): string {
  if (isMissing(value)) return "";
  const v = value.trim();

  // Already ISO: YYYY-MM-DD (optionally with a time part).
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    return isValidDate(y, m, d) ? formatDate(y, m, d) : "";
  }

  // D/M/Y or D-M-Y or D.M.Y (also catches M/D/Y when the second part > 12).
  const numeric = v.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const y = Number(numeric[3]);
    let d: number;
    let m: number;
    if (a > 12) {
      d = a;
      m = b;
    } else if (b > 12) {
      d = b;
      m = a;
    } else {
      d = a; // Ambiguous: assume DD/MM.
      m = b;
    }
    return isValidDate(y, m, d) ? formatDate(y, m, d) : "";
  }

  // "12 Jan 2025" / "12 January 2025".
  const dmy = v.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (dmy) {
    const m = MONTHS[dmy[2].toLowerCase()];
    if (m) {
      const d = Number(dmy[1]);
      const y = Number(dmy[3]);
      if (isValidDate(y, m, d)) return formatDate(y, m, d);
    }
    return "";
  }

  // "Jan 12, 2025" / "January 12 2025".
  const mdy = v.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (mdy) {
    const m = MONTHS[mdy[1].toLowerCase()];
    if (m) {
      const d = Number(mdy[2]);
      const y = Number(mdy[3]);
      if (isValidDate(y, m, d)) return formatDate(y, m, d);
    }
    return "";
  }

  // Last resort: the built-in parser.
  const parsed = new Date(v);
  if (!Number.isNaN(parsed.getTime())) {
    return formatDate(
      parsed.getFullYear(),
      parsed.getMonth() + 1,
      parsed.getDate()
    );
  }
  return "";
}

/* ---------- operations (pure: never mutate the input rows) ---------- */

function dropDuplicates(rows: Row[], columns?: string[]): Row[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const keys =
      columns && columns.length > 0 ? columns : Object.keys(row);
    const k = JSON.stringify(keys.map((c) => row[c] ?? ""));
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function dropMissing(rows: Row[], column: string): Row[] {
  return rows.filter((row) => !isMissing(row[column]));
}

function fillMissing(rows: Row[], column: string, value: string): Row[] {
  return rows.map((row) =>
    isMissing(row[column]) ? { ...row, [column]: value } : row
  );
}

function trimColumn(rows: Row[], column: string): Row[] {
  return rows.map((row) => ({ ...row, [column]: (row[column] ?? "").trim() }));
}

function changeCase(
  rows: Row[],
  column: string,
  mode: "lower" | "upper" | "title"
): Row[] {
  return rows.map((row) => {
    const v = row[column] ?? "";
    let out = v;
    if (mode === "lower") out = v.toLowerCase();
    else if (mode === "upper") out = v.toUpperCase();
    else
      out = v
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase());
    return { ...row, [column]: out };
  });
}

function renameColumn(rows: Row[], from: string, to: string): Row[] {
  return rows.map((row) => {
    const { [from]: value, ...rest } = row;
    return { ...rest, [to]: value ?? "" };
  });
}

function dropColumn(rows: Row[], column: string): Row[] {
  return rows.map((row) => {
    const next = { ...row };
    delete next[column];
    return next;
  });
}

function convertType(
  rows: Row[],
  column: string,
  to: "number" | "date"
): Row[] {
  return rows.map((row) => {
    const v = row[column] ?? "";
    let out: string;
    if (to === "number") {
      const n = parseNumberLoose(v);
      out = n === null ? "" : String(n);
    } else {
      out = parseDateLoose(v);
    }
    return { ...row, [column]: out };
  });
}

type FilterOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "less_than"
  | "contains";

function filterRows(
  rows: Row[],
  column: string,
  operator: FilterOperator,
  value: string
): Row[] {
  const numValue = toNumber(value);
  return rows.filter((row) => {
    const cell = row[column] ?? "";
    const numCell = toNumber(cell);
    switch (operator) {
      case "equals":
        if (numCell !== null && numValue !== null) return numCell === numValue;
        return cell === value;
      case "not_equals":
        if (numCell !== null && numValue !== null) return numCell !== numValue;
        return cell !== value;
      case "greater_than":
        if (numCell !== null && numValue !== null) return numCell > numValue;
        return cell > value;
      case "less_than":
        if (numCell !== null && numValue !== null) return numCell < numValue;
        return cell < value;
      case "contains":
        return cell.toLowerCase().includes(value.toLowerCase());
    }
  });
}

function sortRows(
  rows: Row[],
  column: string,
  direction: "asc" | "desc"
): Row[] {
  const factor = direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[column] ?? "";
    const bv = b[column] ?? "";
    const an = toNumber(av);
    const bn = toNumber(bv);
    if (an !== null && bn !== null) return (an - bn) * factor;
    return av.localeCompare(bv) * factor;
  });
}

function groupAggregate(
  rows: Row[],
  groupBy: string[],
  aggregations: Aggregation[]
): Row[] {
  const groups = new Map<string, { key: Row; members: Row[] }>();
  for (const row of rows) {
    const keyValues = groupBy.map((c) => row[c] ?? "");
    const key = JSON.stringify(keyValues);
    let g = groups.get(key);
    if (!g) {
      const keyRow: Row = {};
      groupBy.forEach((c, i) => {
        keyRow[c] = keyValues[i];
      });
      g = { key: keyRow, members: [] };
      groups.set(key, g);
    }
    g.members.push(row);
  }

  const out: Row[] = [];
  for (const { key, members } of groups.values()) {
    const row: Row = { ...key };
    for (const agg of aggregations) {
      const values = members
        .map((m) => m[agg.column] ?? "")
        .filter((v) => !isMissing(v));
      if (agg.fn === "count") {
        row[agg.as] = String(values.length);
        continue;
      }
      const nums = values
        .map((v) => parseNumberLoose(v))
        .filter((n): n is number => n !== null);
      if (nums.length === 0) {
        row[agg.as] = "";
        continue;
      }
      if (agg.fn === "sum")
        row[agg.as] = String(nums.reduce((a, b) => a + b, 0));
      else if (agg.fn === "mean")
        row[agg.as] = String(
          Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100
        );
      else if (agg.fn === "min") row[agg.as] = String(Math.min(...nums));
      else row[agg.as] = String(Math.max(...nums));
    }
    out.push(row);
  }
  return out;
}

function replaceValues(
  rows: Row[],
  column: string,
  from: string,
  to: string
): Row[] {
  return rows.map((row) =>
    row[column] === from ? { ...row, [column]: to } : row
  );
}

/* ---------- validation + plan runner ---------- */

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function requireColumn(
  columns: string[],
  name: unknown,
  stepNo: number,
  op: string
): string {
  if (!isNonEmptyString(name)) {
    throw new Error(
      `Step ${stepNo} (${op}): "column" must be a non-empty string.`
    );
  }
  if (!columns.includes(name)) {
    throw new Error(
      `Step ${stepNo} (${op}): column "${name}" does not exist. Available columns: ${columns.join(", ") || "(none)"}.`
    );
  }
  return name;
}

/**
 * Apply a plan of steps to rows, in order. Validates every step first
 * (unknown operation, missing column, bad parameters) and throws an Error
 * naming the failing step. The input rows are never mutated.
 */
export function runPlan(inputRows: Row[], steps: PlanStep[]): Row[] {
  if (!Array.isArray(steps)) {
    throw new Error("Plan must be an array of steps.");
  }
  if (inputRows.length === 0) return [];

  let rows: Row[] = inputRows.map((r) => ({ ...r }));
  let columns: string[] = Object.keys(rows[0]);

  steps.forEach((step, index) => {
    const stepNo = index + 1;
    if (!step || typeof step !== "object" || typeof step.op !== "string") {
      throw new Error(`Step ${stepNo}: each step needs an "op" name.`);
    }
    const op = step.op;
    if (!KNOWN_OPS.includes(op as PlanStep["op"])) {
      throw new Error(`Step ${stepNo}: unknown operation "${op}".`);
    }

    switch (step.op) {
      case "drop_duplicates": {
        if (step.columns !== undefined) {
          if (
            !Array.isArray(step.columns) ||
            step.columns.some((c) => !isNonEmptyString(c))
          ) {
            throw new Error(
              `Step ${stepNo} (${op}): "columns" must be an array of column names.`
            );
          }
          for (const c of step.columns) requireColumn(columns, c, stepNo, op);
        }
        rows = dropDuplicates(rows, step.columns);
        break;
      }
      case "drop_missing": {
        const column = requireColumn(columns, step.column, stepNo, op);
        rows = dropMissing(rows, column);
        break;
      }
      case "fill_missing": {
        const column = requireColumn(columns, step.column, stepNo, op);
        if (typeof step.value !== "string") {
          throw new Error(
            `Step ${stepNo} (${op}): "value" must be a string.`
          );
        }
        rows = fillMissing(rows, column, step.value);
        break;
      }
      case "trim": {
        const column = requireColumn(columns, step.column, stepNo, op);
        rows = trimColumn(rows, column);
        break;
      }
      case "change_case": {
        const column = requireColumn(columns, step.column, stepNo, op);
        if (!["lower", "upper", "title"].includes(step.mode)) {
          throw new Error(
            `Step ${stepNo} (${op}): "mode" must be "lower", "upper" or "title".`
          );
        }
        rows = changeCase(rows, column, step.mode);
        break;
      }
      case "rename_column": {
        const from = requireColumn(columns, step.from, stepNo, op);
        if (!isNonEmptyString(step.to)) {
          throw new Error(
            `Step ${stepNo} (${op}): "to" must be a non-empty string.`
          );
        }
        if (step.to !== from && columns.includes(step.to)) {
          throw new Error(
            `Step ${stepNo} (${op}): column "${step.to}" already exists.`
          );
        }
        rows = renameColumn(rows, from, step.to);
        columns = columns.map((c) => (c === from ? step.to : c));
        break;
      }
      case "drop_column": {
        const column = requireColumn(columns, step.column, stepNo, op);
        rows = dropColumn(rows, column);
        columns = columns.filter((c) => c !== column);
        break;
      }
      case "convert_type": {
        const column = requireColumn(columns, step.column, stepNo, op);
        if (step.to !== "number" && step.to !== "date") {
          throw new Error(
            `Step ${stepNo} (${op}): "to" must be "number" or "date".`
          );
        }
        rows = convertType(rows, column, step.to);
        break;
      }
      case "filter_rows": {
        const column = requireColumn(columns, step.column, stepNo, op);
        if (
          !["equals", "not_equals", "greater_than", "less_than", "contains"].includes(
            step.operator
          )
        ) {
          throw new Error(
            `Step ${stepNo} (${op}): "operator" must be one of equals, not_equals, greater_than, less_than, contains.`
          );
        }
        if (typeof step.value !== "string") {
          throw new Error(
            `Step ${stepNo} (${op}): "value" must be a string.`
          );
        }
        rows = filterRows(rows, column, step.operator, step.value);
        break;
      }
      case "sort": {
        const column = requireColumn(columns, step.column, stepNo, op);
        if (step.direction !== "asc" && step.direction !== "desc") {
          throw new Error(
            `Step ${stepNo} (${op}): "direction" must be "asc" or "desc".`
          );
        }
        rows = sortRows(rows, column, step.direction);
        break;
      }
      case "group_aggregate": {
        if (
          !Array.isArray(step.groupBy) ||
          step.groupBy.some((c) => !isNonEmptyString(c))
        ) {
          throw new Error(
            `Step ${stepNo} (${op}): "groupBy" must be an array of column names.`
          );
        }
        for (const c of step.groupBy) requireColumn(columns, c, stepNo, op);
        if (!Array.isArray(step.aggregations) || step.aggregations.length === 0) {
          throw new Error(
            `Step ${stepNo} (${op}): "aggregations" must be a non-empty array.`
          );
        }
        const seenAs = new Set<string>();
        for (const agg of step.aggregations) {
          if (!agg || typeof agg !== "object") {
            throw new Error(`Step ${stepNo} (${op}): bad aggregation entry.`);
          }
          requireColumn(columns, agg.column, stepNo, op);
          if (!["sum", "mean", "count", "min", "max"].includes(agg.fn)) {
            throw new Error(
              `Step ${stepNo} (${op}): aggregation "fn" must be one of sum, mean, count, min, max.`
            );
          }
          if (!isNonEmptyString(agg.as)) {
            throw new Error(
              `Step ${stepNo} (${op}): aggregation "as" must be a non-empty string.`
            );
          }
          if (seenAs.has(agg.as) || step.groupBy.includes(agg.as)) {
            throw new Error(
              `Step ${stepNo} (${op}): duplicate output column "${agg.as}".`
            );
          }
          seenAs.add(agg.as);
        }
        rows = groupAggregate(rows, step.groupBy, step.aggregations);
        columns = [
          ...step.groupBy,
          ...step.aggregations.map((a) => a.as),
        ];
        break;
      }
      case "replace_values": {
        const column = requireColumn(columns, step.column, stepNo, op);
        if (typeof step.from !== "string" || typeof step.to !== "string") {
          throw new Error(
            `Step ${stepNo} (${op}): "from" and "to" must be strings.`
          );
        }
        rows = replaceValues(rows, column, step.from, step.to);
        break;
      }
    }
  });

  return rows;
}

/* ---------- stats ---------- */

export interface ColumnStat {
  nullCount: number;
  uniqueCount: number;
}

export interface TableStats {
  rowCount: number;
  columns: Record<string, ColumnStat>;
}

export function columnStats(rows: Row[]): TableStats {
  const columns: string[] =
    rows.length > 0 ? Object.keys(rows[0]) : [];
  const stats: Record<string, ColumnStat> = {};
  for (const c of columns) {
    const values = rows.map((r) => r[c] ?? "");
    stats[c] = {
      nullCount: values.filter((v) => isMissing(v)).length,
      uniqueCount: new Set(values).size,
    };
  }
  return { rowCount: rows.length, columns: stats };
}

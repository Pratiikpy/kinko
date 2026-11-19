// Batch payment files, parsed on the device.
//
// A payroll file names people and amounts. It is read here and nowhere else:
// it is never uploaded, and only the resulting shielded transfers leave the
// browser. Each row is checked on its own so one typo names its line instead
// of rejecting the whole file.

import { AMOUNT_ERROR_TEXT, parseAmount } from "./format.ts";

/** The most payments one batch file may hold. */
export const MAX_BATCH_ROWS = 200;

/** One valid payment from a batch file. */
export interface BatchRow {
  readonly line: number;
  readonly recipient: string;
  readonly recipientKind: "tag" | "address";
  readonly amount: bigint;
  readonly memo: string;
}

/** A line of a batch file that could not be used, and why. */
export interface BatchIssue {
  readonly line: number;
  readonly message: string;
}

/** A parsed batch file: its valid rows, its problems, and the total of the valid rows. */
export interface ParsedBatch {
  readonly rows: readonly BatchRow[];
  readonly issues: readonly BatchIssue[];
  readonly total: bigint;
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/**
 * Split CSV text into records, honouring quoted fields, escaped quotes and CRLF.
 *
 * @param text - The file's text.
 * @returns One array of cells per record.
 */
export function splitCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src.charAt(i);
    const next = src.charAt(i + 1);
    if (quoted) {
      if (c === '"' && next === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && next === "\n") i++;
      row.push(field);
      out.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}

const TAG = /^@?[a-z0-9_]{3,20}$/i;
const SHIELDED = /^mn_shield-addr_[a-z0-9]+1[02-9ac-hj-np-z]{20,}$/;

/**
 * Classify a recipient as a tag or a Midnight shielded address.
 *
 * @param text - The recipient as written in the file.
 * @returns Which kind it is, or null when it is neither.
 */
export function classifyRecipient(text: string): "tag" | "address" | null {
  const t = text.trim();
  if (SHIELDED.test(t)) return "address";
  if (TAG.test(t)) return "tag";
  return null;
}

const HEADER_WORDS = /^(recipient|to|payee|tag|address|name)$/i;

/**
 * Parse a batch file of `recipient,amount[,memo]` lines, with or without a header row.
 *
 * @param text - The file's text.
 * @returns Valid rows, the problems found per line, and the total of the valid rows.
 */
export function parseBatch(text: string): ParsedBatch {
  const records = splitCsv(text);
  const rows: BatchRow[] = [];
  const issues: BatchIssue[] = [];
  records.forEach((cells, i) => {
    const line = i + 1;
    const [rawRecipient = "", rawAmount = "", ...rest] = cells.map((c) => c.trim());
    if (cells.every((c) => c.trim() === "")) return;
    if (i === 0 && HEADER_WORDS.test(rawRecipient)) return;
    const kind = classifyRecipient(rawRecipient);
    if (!kind) {
      issues.push({
        line,
        message: `"${rawRecipient || "(empty)"}" is not a @tag or a Midnight shielded address.`,
      });
      return;
    }
    // An unquoted "1,250.00" splits into "1" and "250.00": the amount would be $1 and the rest a memo.
    if (/^\d{1,3}$/.test(rawAmount) && /^\d{3}(\.\d+)?$/.test(rest[0] ?? "")) {
      issues.push({
        line,
        message: `"${rawAmount},${rest[0] ?? ""}" has a comma inside the amount. Write it without one, or put it in quotes.`,
      });
      return;
    }
    const amount = parseAmount(rawAmount);
    if (!amount.ok) {
      issues.push({ line, message: AMOUNT_ERROR_TEXT[amount.error] });
      return;
    }
    const recipient =
      kind === "tag" ? `@${rawRecipient.replace(/^@/, "").toLowerCase()}` : rawRecipient;
    rows.push({
      line,
      recipient,
      recipientKind: kind,
      amount: amount.value,
      memo: rest.join(", ").slice(0, 120),
    });
  });
  if (rows.length > MAX_BATCH_ROWS) {
    issues.push({
      line: rows[MAX_BATCH_ROWS]?.line ?? 0,
      message: `A batch holds at most ${String(MAX_BATCH_ROWS)} payments. Split the file.`,
    });
  }
  const kept = rows.slice(0, MAX_BATCH_ROWS);
  return { rows: kept, issues, total: kept.reduce((s, r) => s + r.amount, 0n) };
}

/** A starter file a user can download and fill in. */
export const BATCH_TEMPLATE =
  "recipient,amount,memo\n@alice,1250.00,November retainer\n@bob_designs,480,Logo revisions\n";

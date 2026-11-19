// Structured logging that cannot leak a secret by accident.
//
// Every line is one JSON object. Field names that look like credentials are
// replaced before the line is written, at any depth, so a caller that passes a
// whole request context by mistake still prints nothing sensitive. Request
// bodies and query strings are never logged at all: the redaction is the
// second line of defence, not the first.

/** Log severities, lowest first. */
export enum LogLevel {
  DEBUG = "debug",
  INFO = "info",
  WARN = "warn",
  ERROR = "error",
}

const RANK: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 10,
  [LogLevel.INFO]: 20,
  [LogLevel.WARN]: 30,
  [LogLevel.ERROR]: 40,
};

/** Field names whose values are never printed. */
const SENSITIVE =
  /authorization|api[-_]?key|secret|token|password|signature|cookie|private|seed|mnemonic/i;

/** A value of any JSON-safe shape. */
export type LogFields = Readonly<Record<string, unknown>>;

/** The logging surface the rest of the backend depends on. */
export interface Logger {
  /**
   * Write a debug line.
   *
   * @param message - What happened, in a sentence.
   * @param fields - Extra fields for the line; anything named like a credential is redacted.
   */
  debug(message: string, fields?: LogFields): void;
  /**
   * Write an informational line.
   *
   * @param message - What happened, in a sentence.
   * @param fields - Extra fields for the line; anything named like a credential is redacted.
   */
  info(message: string, fields?: LogFields): void;
  /**
   * Write a warning line.
   *
   * @param message - What happened, in a sentence.
   * @param fields - Extra fields for the line; anything named like a credential is redacted.
   */
  warn(message: string, fields?: LogFields): void;
  /**
   * Write an error line.
   *
   * @param message - What happened, in a sentence.
   * @param fields - Extra fields for the line; anything named like a credential is redacted.
   */
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line it writes. */
  child(fields: LogFields): Logger;
}

const MAX_DEPTH = 5;

/**
 * Copy `value` with every sensitive field replaced by a marker.
 *
 * @param value - Anything a caller wants logged.
 * @param depth - Recursion guard; deeper structures are truncated.
 * @returns A JSON-safe copy with credentials removed.
 */
export const redact = (value: unknown, depth = 0): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE.test(key) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
};

/** Where finished lines go. */
export type LogSink = (line: string) => void;

/**
 * A JSON-lines logger.
 *
 * @param sink - Receives one serialised line per entry.
 * @param level - The lowest severity written.
 * @param base - Fields added to every line.
 * @param now - Clock, injectable for tests.
 * @returns The logger.
 */
export const createLogger = (
  sink: LogSink,
  level: LogLevel = LogLevel.INFO,
  base: LogFields = {},
  now: () => Date = () => new Date(),
): Logger => {
  const write = (severity: LogLevel, message: string, fields?: LogFields): void => {
    if (RANK[severity] < RANK[level]) return;
    const line = {
      time: now().toISOString(),
      level: severity,
      msg: message,
      ...(redact({ ...base, ...fields }) as Record<string, unknown>),
    };
    sink(JSON.stringify(line));
  };
  return {
    debug: (m, f) => {
      write(LogLevel.DEBUG, m, f);
    },
    info: (m, f) => {
      write(LogLevel.INFO, m, f);
    },
    warn: (m, f) => {
      write(LogLevel.WARN, m, f);
    },
    error: (m, f) => {
      write(LogLevel.ERROR, m, f);
    },
    child: (fields) => createLogger(sink, level, { ...base, ...fields }, now),
  };
};

/** A logger that discards everything, for tests and quiet embedding. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

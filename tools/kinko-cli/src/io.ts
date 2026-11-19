// What the CLI needs from the world, passed in so the whole tool can be driven
// from a test with a temporary directory and a fake backend.

/** Process exit codes. */
export enum ExitCode {
  OK = 0,
  /** Something went wrong: the backend refused, a file could not be written, a key is missing. */
  FAILURE = 1,
  /** The command line was wrong. */
  USAGE = 2,
  /** `wait` ended with the invoice cancelled or expired rather than paid. */
  NOT_PAID = 3,
  /** `wait` ran out of time with the invoice still open. */
  TIMEOUT = 4,
}

/** The CLI's view of its surroundings. */
export interface CliIo {
  /** Write to standard output. A newline is added. */
  out(text: string): void;
  /** Write to standard error. A newline is added. */
  err(text: string): void;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Directory relative paths resolve against. */
  readonly cwd: string;
  readonly fetch?: typeof fetch;
  /** Current time in milliseconds. */
  readonly now: () => number;
  /** Poll interval override for `wait`, in milliseconds. */
  readonly pollIntervalMs?: number;
}

/** Raised for a bad command line; becomes exit code 2 with the message and a hint. */
export class UsageError extends Error {
  /**
   * Create a usage error.
   *
   * @param message - What was wrong with the command line.
   */
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

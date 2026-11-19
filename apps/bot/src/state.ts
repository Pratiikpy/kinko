// Where the bot remembers how far through the backend's event feed it has got.
//
// Only a sequence number is kept. A durable list of "which chat cares about
// which invoice" would be a correlation database linking a Telegram account to
// specific invoices; the backend already holds the merchant-to-chat link it
// needs, and the bot holds nothing else.

import { readFile, rename, writeFile } from "node:fs/promises";

/** Remembers a cursor. */
export interface CursorStore {
  /** The saved cursor, or undefined when there is none. */
  load(): Promise<number | undefined>;
  /**
   * Remember a cursor.
   *
   * @param seq - The sequence number of the last event handled.
   */
  save(seq: number): Promise<void>;
}

/** Keeps the cursor in a small JSON file, replaced atomically. */
export class FileCursorStore implements CursorStore {
  readonly #path: string;

  /**
   * Keep the cursor in a file.
   *
   * @param path - Where the file lives.
   */
  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<number | undefined> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const seq = (JSON.parse(text) as { cursor?: unknown }).cursor;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0)
      throw new Error(
        `${this.#path} does not hold a valid cursor. Delete it to start from the newest event.`,
      );
    return seq;
  }

  /** @inheritdoc */
  async save(seq: number): Promise<void> {
    const temporary = `${this.#path}.${String(process.pid)}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ cursor: seq })}\n`);
    await rename(temporary, this.#path);
  }
}

/** Keeps the cursor in memory, for tests. */
export class MemoryCursorStore implements CursorStore {
  #seq: number | undefined;

  /**
   * Keep the cursor in memory.
   *
   * @param initial - The cursor to start from, if any.
   */
  constructor(initial?: number) {
    this.#seq = initial;
  }

  load(): Promise<number | undefined> {
    return Promise.resolve(this.#seq);
  }

  /** @inheritdoc */
  save(seq: number): Promise<void> {
    this.#seq = seq;
    return Promise.resolve();
  }
}

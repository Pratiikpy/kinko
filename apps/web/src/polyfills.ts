// Midnight's address codec and parts of the SDK were written for Node: they
// use the global Buffer and read `process`. The browser has neither, so the
// npm `buffer` package stands in for one and a minimal `process` for the
// other. This module is imported first, before anything that might reach for
// them.

import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer; process?: unknown };
g.Buffer ??= Buffer;
g.process ??= {
  env: { NODE_ENV: import.meta.env.MODE },
  browser: true,
  version: "",
  versions: {},
  platform: "browser",
  nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => {
    queueMicrotask(() => {
      fn(...args);
    });
  },
};

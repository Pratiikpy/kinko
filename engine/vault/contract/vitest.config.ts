import { defineConfig } from "vitest/config";

// The simulator tests run whole vault flows in-process, and the circuits that settle a
// request now also update the supply counters, so one test can take several seconds on a
// busy machine: the default five would fail runs that are merely slow.
export default defineConfig({
  test: { testTimeout: 60_000 },
});

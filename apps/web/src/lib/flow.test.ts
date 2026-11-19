import { describe, expect, it } from "vitest";

import { secondsLeft, stepsFor } from "./flow.ts";
import { type Stage, STAGES } from "./relayer.ts";

const states = (s: ReturnType<typeof stepsFor>) => s.map((x) => `${x.key}:${x.state}`);

describe("deposit steps", () => {
  it("start with funding the address", () => {
    const s = stepsFor("deposit", { phase: "funding" });
    expect(s[0]).toMatchObject({ key: "fund", state: "current", who: "you" });
    expect(s.slice(1).every((x) => x.state === "todo")).toBe(true);
  });

  it("mark the start as current while it is being signed", () => {
    expect(states(stepsFor("deposit", { phase: "starting" })).slice(0, 2)).toEqual([
      "fund:done",
      "start:current",
    ]);
  });

  it("follow each relayer stage, with everything before it done", () => {
    const order: Stage[] = ["queued", "flushed", "sent", "signed", "broadcast", "attested"];
    order.forEach((stage, i) => {
      const s = stepsFor("deposit", { phase: "relaying", lastStage: stage });
      const done = s.filter((x) => x.state === "done").map((x) => x.key);
      expect(done).toEqual(["fund", "start", ...order.slice(0, i + 1)]);
      expect(s.filter((x) => x.state === "current")).toHaveLength(1);
    });
  });

  it("hand the last step to the person once the attestation is in", () => {
    const s = stepsFor("deposit", { phase: "relaying", lastStage: "ready" });
    const last = s.at(-1);
    expect(last).toMatchObject({
      key: "ready",
      state: "current",
      who: "you",
      title: "Receive your private dollars",
    });
  });

  it("show everything done when settled", () => {
    expect(stepsFor("deposit", { phase: "done" }).every((x) => x.state === "done")).toBe(true);
    expect(secondsLeft(stepsFor("deposit", { phase: "done" }))).toBe(0);
  });

  it("mark the step that stopped when the relayer fails", () => {
    const s = stepsFor("deposit", { phase: "failed", lastStage: "signed" });
    expect(s.filter((x) => x.state === "failed").map((x) => x.key)).toEqual(["broadcast"]);
  });
});

describe("withdraw steps", () => {
  it("have no funding step and their own last step", () => {
    const s = stepsFor("withdraw", { phase: "relaying" });
    expect(s[0]?.key).toBe("start");
    expect(s[0]?.state).toBe("done");
    expect(s.at(-1)?.title).toBe("Close the withdrawal");
  });

  it("produce exactly one current step for every reported stage", () => {
    for (const stage of STAGES.filter((x) => x !== "failed" && x !== "completed")) {
      const s = stepsFor("withdraw", { phase: "relaying", lastStage: stage });
      expect(s.filter((x) => x.state === "current")).toHaveLength(1);
    }
  });

  it("count down the estimate as steps complete", () => {
    const early = secondsLeft(stepsFor("withdraw", { phase: "relaying", lastStage: "queued" }));
    const late = secondsLeft(stepsFor("withdraw", { phase: "relaying", lastStage: "attested" }));
    expect(late).toBeLessThan(early);
  });
});

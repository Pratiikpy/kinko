import { describe, expect, it } from "vitest";

import {
  activity,
  emptyRecords,
  isRecordsDoc,
  localId,
  openRequests,
  patch,
  remove,
  upsert,
  type VaultRequestRecord,
} from "./records.ts";

const request = (over: Partial<VaultRequestRecord> = {}): VaultRequestRecord => ({
  localId: "r1",
  kind: "deposit",
  amount: "100000000",
  createdAt: 1,
  updatedAt: 1,
  phase: "funding",
  ...over,
});

describe("records", () => {
  it("inserts newest first and replaces by key, without touching the original", () => {
    const empty = emptyRecords();
    const one = upsert(empty, "requests", request());
    const two = upsert(one, "requests", request({ localId: "r2", createdAt: 2 }));
    const replaced = upsert(two, "requests", request({ phase: "done" }));
    expect(empty.requests).toHaveLength(0);
    expect(two.requests.map((r) => r.localId)).toEqual(["r2", "r1"]);
    expect(replaced.requests.map((r) => [r.localId, r.phase])).toEqual([
      ["r1", "done"],
      ["r2", "funding"],
    ]);
    expect(two.requests.find((r) => r.localId === "r1")?.phase).toBe("funding");
  });

  it("patches one record and leaves a missing key alone", () => {
    const doc = upsert(emptyRecords(), "requests", request());
    const patched = patch(doc, "requests", "r1", { phase: "relaying", requestId: "ab" });
    expect(patched.requests[0]).toMatchObject({
      phase: "relaying",
      requestId: "ab",
      amount: "100000000",
    });
    expect(patch(doc, "requests", "nope", { phase: "done" })).toBe(doc);
  });

  it("removes by key", () => {
    const doc = upsert(
      upsert(emptyRecords(), "tags", { name: "a", secret: "s", registeredAt: 1 }),
      "tags",
      { name: "b", secret: "s", registeredAt: 2 },
    );
    expect(remove(doc, "tags", "a").tags.map((t) => t.name)).toEqual(["b"]);
  });

  it("lists unfinished requests oldest first", () => {
    let doc = emptyRecords();
    doc = upsert(doc, "requests", request({ localId: "a", createdAt: 5, phase: "relaying" }));
    doc = upsert(doc, "requests", request({ localId: "b", createdAt: 3, phase: "failed" }));
    doc = upsert(doc, "requests", request({ localId: "c", createdAt: 1, phase: "done" }));
    expect(openRequests(doc).map((r) => r.localId)).toEqual(["b", "a"]);
  });

  it("merges an activity feed across kinds, newest first", () => {
    let doc = emptyRecords();
    doc = upsert(doc, "requests", request({ updatedAt: 10 }));
    doc = upsert(doc, "payments", {
      id: "p",
      to: "x",
      toLabel: "@bob",
      amount: "1",
      createdAt: 30,
      kind: "tag",
    });
    doc = upsert(doc, "invoices", {
      commitment: "c",
      title: "Logo",
      memo: "",
      amount: "5",
      kind: "standard",
      merchantKey: "",
      payout: "",
      salt: "",
      ownerSecret: "",
      expiresAt: "0",
      createdAt: 20,
      link: "",
      status: "settled",
    });
    const feed = activity(doc);
    expect(feed.map((i) => i.title)).toEqual([
      "Paid @bob",
      "Requested: Logo",
      "Added from Ethereum",
    ]);
    expect(feed.map((i) => i.direction)).toEqual(["out", "in", "in"]);
    expect(feed[1]?.detail).toBe("Paid");
  });

  it("recognises its own documents and refuses anything else", () => {
    expect(isRecordsDoc(emptyRecords())).toBe(true);
    expect(isRecordsDoc({ ...emptyRecords(), version: 2 })).toBe(false);
    expect(isRecordsDoc({ version: 1 })).toBe(false);
    expect(isRecordsDoc("{}")).toBe(false);
  });

  it("draws distinct local ids", () => {
    const ids = new Set(Array.from({ length: 200 }, localId));
    expect(ids.size).toBe(200);
  });
});

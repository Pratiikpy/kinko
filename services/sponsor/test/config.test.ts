import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_FEE_SPECK, readConfig } from "../src/config.ts";

const PAY = "29".repeat(32);

/** A repository with a deployment record and a sponsor wallet, as `deploy` and `fund` leave it. */
function repo(withDeployment = true): string {
  const root = mkdtempSync(join(tmpdir(), "kinko-sponsor-"));
  mkdirSync(join(root, "deployments"));
  mkdirSync(join(root, ".secrets", "undeployed"), { recursive: true });
  if (withDeployment) {
    writeFileSync(
      join(root, "deployments", "undeployed.json"),
      JSON.stringify({ pay: { contractAddress: PAY } }),
    );
  }
  writeFileSync(
    join(root, ".secrets", "undeployed", "sponsor.json"),
    JSON.stringify({ seed: "ab".repeat(32) }),
  );
  return root;
}

describe("readConfig", () => {
  it("allowlists the deployed pay contract and only invoice settlement by default", () => {
    const c = readConfig({ SPONSOR_BUDGET_SPECK: "1000" }, repo(), "undeployed");
    expect(c.policy.contracts).toEqual([PAY]);
    expect(c.policy.circuits).toEqual(["settle_invoice", "settle_invoice_converted"]);
    expect(c.policy.maxFeeSpeck).toBe(DEFAULT_MAX_FEE_SPECK);
    expect(c.seed).toBe("ab".repeat(32));
    expect(c.port).toBe(3300);
  });

  it("refuses to start without a budget, or with one that is not a positive integer", () => {
    for (const budget of [undefined, "", "0", "-5", "1e18", "lots"]) {
      expect(() => readConfig({ SPONSOR_BUDGET_SPECK: budget }, repo(), "undeployed")).toThrow(
        /SPONSOR_BUDGET_SPECK/,
      );
    }
  });

  it("refuses to start with nothing to allowlist", () => {
    expect(() => readConfig({ SPONSOR_BUDGET_SPECK: "1" }, repo(false), "undeployed")).toThrow(
      /No contract to sponsor/,
    );
  });

  it("refuses to start without a wallet, and names how to make one", () => {
    const root = repo();
    expect(() =>
      readConfig(
        { SPONSOR_BUDGET_SPECK: "1", KINKO_SECRETS_DIR: join(root, "nowhere") },
        root,
        "undeployed",
      ),
    ).toThrow(/sponsor fund/);
  });

  it("takes the operator's allowlist and limits over the defaults", () => {
    const c = readConfig(
      {
        SPONSOR_BUDGET_SPECK: "9",
        SPONSOR_CONTRACTS: "aa, bb",
        SPONSOR_CIRCUITS: "settle_invoice,settle_batch",
        SPONSOR_MAX_FEE_SPECK: "7",
        SPONSOR_RATE_MAX: "2",
      },
      repo(),
      "undeployed",
    );
    expect(c.policy).toMatchObject({
      contracts: ["aa", "bb"],
      circuits: ["settle_invoice", "settle_batch"],
      maxFeeSpeck: 7n,
      budgetSpeck: 9n,
    });
    expect(c.policy.rateLimit.maxRequests).toBe(2);
  });

  it("refuses to start on a limit that is not a whole number, instead of switching the limit off", () => {
    for (const [name, value] of [
      ["SPONSOR_RATE_MAX", "5/min"],
      ["SPONSOR_MAX_ACTIONS", "one"],
      ["SPONSOR_RATE_WINDOW_MS", "-1"],
      ["SPONSOR_RATE_MAX", "0"],
      ["SPONSOR_PORT", "80.5"],
      ["SPONSOR_MAX_FEE_SPECK", "-1"],
      ["SPONSOR_MAX_FEE_SPECK", "0x10"],
    ] as const) {
      expect(() =>
        readConfig(
          { SPONSOR_BUDGET_SPECK: "9", SPONSOR_CONTRACTS: "aa", [name]: value },
          repo(),
          "undeployed",
        ),
      ).toThrow(new RegExp(`${name} must be a (positive )?whole number`));
    }
  });
});

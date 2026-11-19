import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type KinkoDeployment,
  readDeployment,
  selectedContracts,
  writeDeployment,
} from "../src/deploy-kinko.ts";
import { resolveMaintenanceEnv } from "../src/split-deploy.ts";

const addr = (c: string) => c.repeat(64);
const part = (c: string) => ({ contractAddress: addr(c), txId: `00${c}`, circuits: ["a"] });

const DEPLOYMENT: KinkoDeployment = {
  networkId: "undeployed",
  vault: addr("e"),
  usdc: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
  kusdColor: addr("c"),
  oraclePublicKey: { x: "1", y: "2" },
  pay: part("1"),
  tags: part("2"),
  gift: part("3"),
  disclosure: part("5"),
  deployedAt: "2026-11-15T00:00:00.000Z",
};

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "kinko-deploy-"));
  mkdirSync(join(root, "apps", "web"), { recursive: true });
  return root;
}

describe("writeDeployment", () => {
  it("writes the record, the web app's env and the backend's env", () => {
    const root = repo();
    const paths = writeDeployment(DEPLOYMENT, root, { VITE_RELAYER_URL: "http://localhost:3200" });
    expect(paths).toHaveLength(3);
    expect(readDeployment(root, "undeployed")).toEqual(DEPLOYMENT);

    const web = readFileSync(join(root, "apps", "web", ".env.undeployed.local"), "utf8");
    expect(web).toContain(`VITE_KINKO_PAY_ADDRESS=${addr("1")}`);
    expect(web).toContain(`VITE_KINKO_TAGS_ADDRESS=${addr("2")}`);
    expect(web).toContain(`VITE_KINKO_GIFT_ADDRESS=${addr("3")}`);
    expect(web).toContain(`VITE_KINKO_DISCLOSURE_ADDRESS=${addr("5")}`);
    expect(web).toContain("VITE_RELAYER_URL=http://localhost:3200");

    const backend = readFileSync(join(root, "deployments", "undeployed.backend.env"), "utf8");
    expect(backend).toBe(`KINKO_PAY_ADDRESS=${addr("1")}\n`);
  });

  it("never writes a secret", () => {
    const root = repo();
    writeDeployment(DEPLOYMENT, root, {});
    const all = [
      readFileSync(join(root, "deployments", "undeployed.json"), "utf8"),
      readFileSync(join(root, "apps", "web", ".env.undeployed.local"), "utf8"),
    ].join("\n");
    expect(all).not.toMatch(/secret|seed|MAINTENANCE/i);
  });
});

describe("resolveMaintenanceEnv", () => {
  it("keeps a given key", () => {
    const env = { MAINTENANCE_SIGNING_KEY: "ab".repeat(32) };
    expect(resolveMaintenanceEnv(env, "preprod")).toBe(env);
  });

  it("generates a throwaway key only on a local chain", () => {
    const local = resolveMaintenanceEnv({}, "undeployed");
    expect(local.MAINTENANCE_SIGNING_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(() => resolveMaintenanceEnv({}, "preprod")).toThrow(/MAINTENANCE_SIGNING_KEY/);
  });
});

describe("selectedContracts", () => {
  it("deploys every contract unless told otherwise", () => {
    expect([...selectedContracts({})]).toEqual(["pay", "tags", "gift", "disclosure"]);
  });

  it("deploys only the named contracts", () => {
    expect([...selectedContracts({ KINKO_DEPLOY_ONLY: " disclosure, gift " })]).toEqual([
      "disclosure",
      "gift",
    ]);
  });

  it("refuses a name that is not a contract", () => {
    expect(() => selectedContracts({ KINKO_DEPLOY_ONLY: "pay,vault" })).toThrow(/"vault"/);
  });
});

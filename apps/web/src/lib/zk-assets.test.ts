import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveZkAsset } from "../../zk-assets.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kinko-zk-"));
  const managed = join(root, "kinko_pay");
  mkdirSync(join(managed, "keys"), { recursive: true });
  mkdirSync(join(managed, "zkir"), { recursive: true });
  writeFileSync(join(managed, "keys", "create_invoice.prover"), "p");
  writeFileSync(join(managed, "zkir", "create_invoice.bzkir"), "z");
  mkdirSync(join(managed, "compiler"), { recursive: true });
  writeFileSync(join(managed, "compiler", "contract-manifest.json"), "{}");
  writeFileSync(join(root, "secret.txt"), "s");
  return { root, dirs: { kinko_pay: managed } };
}

describe("resolveZkAsset", () => {
  it("serves a key and a ZK IR file of a known contract", () => {
    const { dirs } = fixture();
    expect(resolveZkAsset(dirs, "/zk/kinko_pay/keys/create_invoice.prover")).toBe(
      join(dirs.kinko_pay, "keys", "create_invoice.prover"),
    );
    expect(resolveZkAsset(dirs, "/zk/kinko_pay/zkir/create_invoice.bzkir")).toBeDefined();
    expect(resolveZkAsset(dirs, "/zk/kinko_pay/compiler/contract-manifest.json")).toBeDefined();
  });

  it("refuses unknown contracts, subdirectories and missing files", () => {
    const { dirs } = fixture();
    expect(resolveZkAsset(dirs, "/zk/other/keys/create_invoice.prover")).toBeUndefined();
    expect(resolveZkAsset(dirs, "/zk/kinko_pay/contract/index.js")).toBeUndefined();
    expect(resolveZkAsset(dirs, "/zk/kinko_pay/keys/missing.prover")).toBeUndefined();
  });

  it("refuses traversal and hidden files", () => {
    const { dirs } = fixture();
    expect(resolveZkAsset(dirs, "/zk/kinko_pay/keys/../../secret.txt")).toBeUndefined();
    expect(resolveZkAsset(dirs, "/zk/kinko_pay/keys/..")).toBeUndefined();
    expect(resolveZkAsset(dirs, "/zk/kinko_pay/keys/%2e%2e%2fsecret.txt")).toBeUndefined();
    expect(resolveZkAsset(dirs, "/zk/kinko_pay/keys/.env")).toBeUndefined();
  });
});

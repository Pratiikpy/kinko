// SPDX-License-Identifier: Apache-2.0
//
// The deployment ceremony: a sound one deploys and verifies from public state alone; every
// unsound one is refused by the constructor and flagged by the off-chain check, for the same reason.

import type { JubjubPoint } from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";

import {
  checkKeyholderShare,
  type DeploymentConfig,
  generateExaminerKey,
  ledger,
  modL,
  pureCircuits,
  runCeremony,
  verifyConfig,
  verifyDeployment,
} from "../src/index.ts";
import { deployConfig, Deployment, refusal } from "./harness.ts";

const IDENTITY = pureCircuits.identityPoint();
const G = (k: bigint): JubjubPoint => pureCircuits.pubKeyOf(k);

/** Builds an unsound variant of a fresh ceremony's config. */
const variant = (change: (c: DeploymentConfig) => Partial<DeploymentConfig>): DeploymentConfig => {
  const { config } = runCeremony();
  return { ...config, ...change(config) };
};

describe("ceremony", () => {
  it("a fresh ceremony passes its own checks and every keyholder's share checks out", () => {
    const c = runCeremony();
    expect(verifyConfig(c.config)).toEqual({ ok: true, problems: [] });
    for (const share of c.keyholders) expect(checkKeyholderShare(share, c.config).ok).toBe(true);
  });

  it("a deployed contract can be verified by anyone from its public ledger", async () => {
    const d = await Deployment.create();
    const l = d.ledger();
    expect(verifyDeployment(l)).toEqual({ ok: true, problems: [] });
    expect(l.threshold).toBe(2n);
    expect(l.disclosurePk).toEqual(d.ceremony.config.disclosurePk);
    expect(l.bindingPk).toEqual(d.ceremony.config.bindingPk);
  });

  it("a keyholder detects a share or binding scalar that does not match the published keys", () => {
    const c = runCeremony();
    const tampered = { ...c.keyholders[1], scalar: modL(c.keyholders[1].scalar + 1n) };
    expect(checkKeyholderShare(tampered, c.config).problems).toEqual([
      "keyholder 1's share does not match its published key",
    ]);
    const wrongBinding = {
      ...c.keyholders[0],
      bindingScalar: modL(c.keyholders[0].bindingScalar + 1n),
    };
    expect(checkKeyholderShare(wrongBinding, c.config).problems).toEqual([
      "keyholder 0's binding scalar does not match the binding key",
    ]);
  });

  it("any two keyholder keys reconstruct the disclosure key, in point form", () => {
    const c = runCeremony();
    const [k0, k1, k2] = c.config.keyholderPks;
    // λ for {1,2} is (2, −1); for {2,3} it is (3, −2).
    const neg = (k: bigint): bigint => modL(-k);
    expect(
      pureCircuits.addPoints(pureCircuits.mulPoint(k0, 2n), pureCircuits.mulPoint(k1, neg(1n))),
    ).toEqual(c.config.disclosurePk);
    expect(
      pureCircuits.addPoints(pureCircuits.mulPoint(k1, 3n), pureCircuits.mulPoint(k2, neg(2n))),
    ).toEqual(c.config.disclosurePk);
  });
});

describe("constructor refusals, each also flagged off chain", () => {
  it("BAD_OPERATOR: a zero operator commitment", async () => {
    const config = variant(() => ({ operatorCommitment: new Uint8Array(32) }));
    expect(verifyConfig(config).problems).toEqual(["operator commitment is zero"]);
    await expect(deployConfig(config)).rejects.toThrow(refusal("BAD_OPERATOR"));
  });

  it("BAD_DISCLOSURE_KEY: the identity as disclosure key", async () => {
    const config = variant(() => ({ disclosurePk: IDENTITY }));
    expect(verifyConfig(config).ok).toBe(false);
    await expect(deployConfig(config)).rejects.toThrow(refusal("BAD_DISCLOSURE_KEY"));
  });

  it("BAD_KEYHOLDER_KEY: an identity keyholder key", async () => {
    const config = variant((c) => ({
      keyholderPks: [IDENTITY, c.keyholderPks[1], c.keyholderPks[2]],
    }));
    expect(verifyConfig(config).ok).toBe(false);
    await expect(deployConfig(config)).rejects.toThrow(refusal("BAD_KEYHOLDER_KEY"));
  });

  it("BAD_KEYHOLDER_KEY: a keyholder holding the whole disclosure key", async () => {
    const config = variant((c) => ({
      keyholderPks: [c.keyholderPks[0], c.disclosurePk, c.keyholderPks[2]],
    }));
    expect(verifyConfig(config).ok).toBe(false);
    await expect(deployConfig(config)).rejects.toThrow(refusal("BAD_KEYHOLDER_KEY"));
  });

  it("BAD_KEYHOLDER_KEY: two keyholders with one key", async () => {
    const config = variant((c) => ({
      keyholderPks: [c.keyholderPks[0], c.keyholderPks[1], c.keyholderPks[1]],
    }));
    expect(verifyConfig(config).problems).toContain("two keyholders share a key");
    await expect(deployConfig(config)).rejects.toThrow(refusal("BAD_KEYHOLDER_KEY"));
  });

  it("BAD_BINDING_KEY: the identity as binding key", async () => {
    const config = variant(() => ({ bindingPk: IDENTITY }));
    expect(verifyConfig(config).ok).toBe(false);
    await expect(deployConfig(config)).rejects.toThrow(refusal("BAD_BINDING_KEY"));
  });

  it("BAD_BINDING_KEY: a binding key equal to a keyholder key", async () => {
    const config = variant((c) => ({ bindingPk: c.keyholderPks[2] }));
    expect(verifyConfig(config).ok).toBe(false);
    await expect(deployConfig(config)).rejects.toThrow(refusal("BAD_BINDING_KEY"));
  });

  it("BAD_KEY_SHARING: keyholder keys that are not shares of the disclosure key", async () => {
    const [a, b, c] = [generateExaminerKey(), generateExaminerKey(), generateExaminerKey()];
    const config = variant(() => ({ keyholderPks: [a.publicKey, b.publicKey, c.publicKey] }));
    expect(verifyConfig(config).ok).toBe(false);
    await expect(deployConfig(config)).rejects.toThrow(refusal("BAD_KEY_SHARING"));
  });

  it("BAD_KEY_SHARING: a consistent first pair with an inconsistent third share", async () => {
    // f(1) and f(2) lie on the line and f(3) does not: the first Feldman check passes, the second fails.
    const sk = 11n;
    const a = 5n;
    const config = variant(() => ({
      disclosurePk: G(sk),
      keyholderPks: [G(sk + a), G(sk + 2n * a), G(sk + 3n * a + 1n)],
    }));
    expect(verifyConfig(config).problems).toEqual([
      "keyholders 0 and 2 do not reconstruct the disclosure key",
      "keyholders 1 and 2 do not reconstruct the disclosure key",
    ]);
    await expect(deployConfig(config)).rejects.toThrow(refusal("BAD_KEY_SHARING"));
  });

  it("a hand-built sound sharing deploys and verifies", async () => {
    const sk = 11n;
    const a = 5n;
    const config = variant(() => ({
      disclosurePk: G(sk),
      keyholderPks: [G(sk + a), G(sk + 2n * a), G(sk + 3n * a)],
      bindingPk: G(99n),
    }));
    expect(verifyConfig(config).ok).toBe(true);
    expect(verifyDeployment(ledger(await deployConfig(config))).ok).toBe(true);
  });
});

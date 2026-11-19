// SPDX-License-Identifier: Apache-2.0
//
// The deployment ceremony for Kinko examiner disclosure.
//
// A dealer draws the disclosure secret sk, splits it 2-of-3 on a line f(x) = sk + a·x, draws the
// binding scalar k that all three keyholders share, checks the result, hands each keyholder its
// share, and forgets sk and a. Nothing secret survives the ceremony outside the keyholders.
//
// The dealer is trusted to forget. It is not trusted to be correct: everything a wrong ceremony
// could break is public and checked twice, by the contract constructor at deployment and by
// `verifyDeployment` for anyone looking at a deployment they did not make.

import type { JubjubPoint } from "@midnight-ntwrk/compact-runtime";

import {
  isIdentity,
  lagrangeAtZero,
  modL,
  pointOf,
  randomBytes32,
  randomScalar,
  samePoint,
} from "./crypto.js";
import {
  type Ledger,
  type LedgerPoint,
  pureCircuits,
} from "./managed/kinko_disclosure/contract/index.js";

/** Keyholder slot on chain. */
export type KeyholderIndex = 0 | 1 | 2;

/** What one keyholder receives and must keep secret. */
export interface KeyholderShare {
  readonly index: KeyholderIndex;
  /** Shamir evaluation point: index + 1. */
  readonly x: bigint;
  /** f(x), this keyholder's share of the disclosure secret. */
  readonly scalar: bigint;
  /** The case-binding scalar k, common to all keyholders. */
  readonly bindingScalar: bigint;
}

/** Public output of the ceremony: exactly what the constructor takes, and what the ledger shows. */
export interface DeploymentConfig {
  readonly operatorCommitment: Uint8Array;
  readonly disclosurePk: JubjubPoint;
  readonly keyholderPks: readonly [JubjubPoint, JubjubPoint, JubjubPoint];
  readonly bindingPk: JubjubPoint;
}

/** Everything a ceremony produces. */
export interface Ceremony {
  readonly config: DeploymentConfig;
  readonly keyholders: readonly [KeyholderShare, KeyholderShare, KeyholderShare];
  /** The compliance operator's secret. Its commitment is in `config`. */
  readonly operatorSecret: Uint8Array;
}

/** The result of a check: every broken property, in the order checked. */
export interface CheckResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

const SLOTS: readonly KeyholderIndex[] = [0, 1, 2];
const PAIRS: readonly (readonly [KeyholderIndex, KeyholderIndex])[] = [
  [0, 1],
  [0, 2],
  [1, 2],
];

const result = (problems: readonly string[]): CheckResult => ({
  ok: problems.length === 0,
  problems,
});

/**
 * Constructor arguments in the order `Contract.initialState` takes them.
 *
 * @param c - The deployment config.
 * @returns `[operatorCommitment, disclosurePk, keyholderPks, bindingPk]`.
 */
export const constructorArgs = (
  c: DeploymentConfig,
): [Uint8Array, JubjubPoint, JubjubPoint[], JubjubPoint] => [
  c.operatorCommitment,
  c.disclosurePk,
  [...c.keyholderPks],
  c.bindingPk,
];

/**
 * Runs the ceremony. The disclosure secret and the sharing polynomial exist only inside this
 * function, and the result is checked with {@link verifyConfig} and {@link checkKeyholderShare}
 * before it is returned.
 *
 * @param operatorSecret - The compliance operator's 32-byte secret; drawn when omitted.
 * @returns Public deployment config, the three keyholder shares and the operator secret.
 * @throws {Error} When the freshly built ceremony fails its own checks.
 */
export function runCeremony(operatorSecret: Uint8Array = randomBytes32()): Ceremony {
  const sk = randomScalar();
  const a = randomScalar();
  const k = randomScalar();
  const share = (index: KeyholderIndex): KeyholderShare => {
    const x = BigInt(index + 1);
    return { index, x, scalar: modL(sk + a * x), bindingScalar: k };
  };
  const keyholders = [share(0), share(1), share(2)] as const;
  const config: DeploymentConfig = {
    operatorCommitment: pureCircuits.operatorCommitmentOf(operatorSecret),
    disclosurePk: pureCircuits.pubKeyOf(sk),
    keyholderPks: [
      pureCircuits.pubKeyOf(keyholders[0].scalar),
      pureCircuits.pubKeyOf(keyholders[1].scalar),
      pureCircuits.pubKeyOf(keyholders[2].scalar),
    ],
    bindingPk: pureCircuits.pubKeyOf(k),
  };

  const problems = [
    ...verifyConfig(config).problems,
    ...keyholders.flatMap((s) => checkKeyholderShare(s, config).problems),
  ];
  if (problems.length > 0)
    throw new Error(`ceremony failed its own checks: ${problems.join("; ")}`);
  return { config, keyholders, operatorSecret };
}

/**
 * What a keyholder checks before accepting its share: that the share matches its published key,
 * and that the binding scalar matches the published binding key.
 *
 * @param share - The share received from the dealer.
 * @param config - The public deployment config.
 * @returns The check result.
 */
export function checkKeyholderShare(share: KeyholderShare, config: DeploymentConfig): CheckResult {
  const problems: string[] = [];
  const who = `keyholder ${String(share.index)}`;
  if (share.x !== BigInt(share.index + 1))
    problems.push(
      `${who} has evaluation point ${String(share.x)}, expected ${String(share.index + 1)}`,
    );
  if (!samePoint(pureCircuits.pubKeyOf(share.scalar), config.keyholderPks[share.index])) {
    problems.push(`${who}'s share does not match its published key`);
  }
  if (!samePoint(pureCircuits.pubKeyOf(share.bindingScalar), config.bindingPk)) {
    problems.push(`${who}'s binding scalar does not match the binding key`);
  }
  return result(problems);
}

/**
 * `λ_a·pk_a + λ_b·pk_b` for a pair of keyholder slots.
 *
 * @param config - The public deployment config.
 * @param a - First keyholder slot.
 * @param b - Second keyholder slot.
 * @returns The interpolated point, or undefined if a key is not a usable curve point.
 */
function combinePublic(
  config: DeploymentConfig,
  a: KeyholderIndex,
  b: KeyholderIndex,
): JubjubPoint | undefined {
  const [la = 0n, lb = 0n] = lagrangeAtZero([BigInt(a + 1), BigInt(b + 1)]);
  try {
    return pureCircuits.addPoints(
      pureCircuits.mulPoint(config.keyholderPks[a], la),
      pureCircuits.mulPoint(config.keyholderPks[b], lb),
    );
  } catch {
    return undefined;
  }
}

/**
 * Checks a deployment config with exactly the properties the constructor enforces: no identity or
 * repeated keys, and every pair of keyholder keys interpolating to the disclosure key.
 *
 * @param config - The public deployment config.
 * @returns The check result.
 */
export function verifyConfig(config: DeploymentConfig): CheckResult {
  const problems: string[] = [];
  const { disclosurePk: d, keyholderPks: kp, bindingPk: b } = config;
  if (config.operatorCommitment.every((x) => x === 0)) problems.push("operator commitment is zero");
  if (isIdentity(d))
    problems.push("disclosure key is the identity: every record is readable by anyone");
  for (const i of SLOTS) {
    const who = `keyholder ${String(i)}`;
    if (isIdentity(kp[i])) problems.push(`${who} key is the identity`);
    if (samePoint(kp[i], d))
      problems.push(`${who} key equals the disclosure key: that keyholder holds the whole secret`);
    if (samePoint(kp[i], b)) problems.push(`${who} key equals the binding key`);
  }
  if (PAIRS.some(([x, y]) => samePoint(kp[x], kp[y]))) problems.push("two keyholders share a key");
  if (isIdentity(b) || samePoint(b, d))
    problems.push("binding key is the identity or the disclosure key");
  for (const [x, y] of PAIRS) {
    const combined = combinePublic(config, x, y);
    if (!combined || !samePoint(combined, d)) {
      problems.push(
        `keyholders ${String(x)} and ${String(y)} do not reconstruct the disclosure key`,
      );
    }
  }
  return result(problems);
}

/**
 * Reads the deployment config back from a deployed contract's public ledger.
 *
 * @param l - The ledger view.
 * @returns The deployment config the contract was built with.
 * @throws {Error} When the ledger does not hold three keyholder keys.
 */
export function configFromLedger(l: Ledger): DeploymentConfig {
  const [k0, k1, k2]: readonly (LedgerPoint | undefined)[] = l.keyholderPks;
  if (!k0 || !k1 || !k2) throw new Error("ledger does not hold three keyholder keys");
  return {
    operatorCommitment: l.operatorCommitment,
    disclosurePk: l.disclosurePk,
    keyholderPks: [pointOf(k0), pointOf(k1), pointOf(k2)],
    bindingPk: l.bindingPk,
  };
}

/**
 * Verifies a deployment somebody else made, from its public ledger alone: the same checks the
 * constructor ran, plus the threshold. A keyholder, examiner or account holder runs this before
 * trusting a deployment address.
 *
 * @param l - The deployed contract's ledger view.
 * @returns The check result.
 */
export function verifyDeployment(l: Ledger): CheckResult {
  const problems = [...verifyConfig(configFromLedger(l)).problems];
  if (l.threshold !== 2n) problems.push(`threshold is ${String(l.threshold)}, expected 2`);
  return result(problems);
}

/**
 * Generates a fresh examiner key pair. The scalar never leaves the examiner; the operator
 * registers only the public key.
 *
 * @returns The examiner scalar and public key.
 */
export function generateExaminerKey(): { scalar: bigint; publicKey: JubjubPoint } {
  const scalar = randomScalar();
  return { scalar, publicKey: pureCircuits.pubKeyOf(scalar) };
}

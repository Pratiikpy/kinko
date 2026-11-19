// SPDX-License-Identifier: Apache-2.0
//
// Witness implementations for Kinko examiner disclosure. Witnesses only supply private inputs;
// every property that matters is re-checked by an assert in the circuit, so a witness that lies
// produces a refusal, never a bad ledger state.

import { randomBytes32, randomScalar } from "./crypto.js";
import type { Statement, Witnesses } from "./managed/kinko_disclosure/contract/index.js";

/**
 * Private state carried by one party's calls. A party only fills in what its role uses: the
 * operator its secret key; a filer its secret key and the statement it is filing; an examiner its
 * scalar; a keyholder its share scalar and the binding scalar.
 */
export interface DisclosurePrivateState {
  /** 32-byte secret of the operator or of a filer. */
  readonly secretKey?: Uint8Array;
  /** Examiner scalar, or a keyholder's share of the disclosure secret. */
  readonly scalar?: bigint;
  /** The keyholders' common case-binding scalar. */
  readonly bindingScalar?: bigint;
  /** The statement the next `file_record` call files. */
  readonly statement?: Statement;
  /** Record nonce for the next filing. Drawn fresh when absent; supply one only to reproduce. */
  readonly recordNonce?: Uint8Array;
  /** Sealing scalar for the next call. Drawn fresh when absent; supply one only to reproduce. */
  readonly ephemeral?: bigint;
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`private state has no ${what}`);
  return value;
}

/**
 * The contract's witnesses, reading from {@link DisclosurePrivateState}. A witness whose input
 * the party did not supply throws before the circuit writes anything.
 */
export const witnesses: Witnesses<DisclosurePrivateState> = {
  localSecretKey: ({ privateState }) => [
    privateState,
    required(privateState.secretKey, "secretKey"),
  ],
  localScalar: ({ privateState }) => [privateState, required(privateState.scalar, "scalar")],
  bindingScalar: ({ privateState }) => [
    privateState,
    required(privateState.bindingScalar, "bindingScalar"),
  ],
  ephemeralScalar: ({ privateState }) => [privateState, privateState.ephemeral ?? randomScalar()],
  recordNonce: ({ privateState }) => [privateState, privateState.recordNonce ?? randomBytes32()],
  statementToFile: ({ privateState }) => [
    privateState,
    required(privateState.statement, "statement"),
  ],
};

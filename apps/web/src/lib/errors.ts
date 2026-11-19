// Turning failures into sentences a person can act on.
//
// A failed contract assert is the product working: the person should read
// "invoice is not open", not a stack of transaction plumbing. A wallet
// refusal is the person's own choice and is never shown as an error.

const ASSERT = /failed assert:\s*(.+?)(?:\n|$)/i;

/** A failure, put in words, with what kind of failure it was. */
export interface Explained {
  readonly message: string;
  /** The person declined in their wallet; show nothing alarming. */
  readonly declined: boolean;
  /** The contract refused before anything was submitted. */
  readonly refusedByContract: boolean;
}

const textOf = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string")
    return e.message;
  return "Something went wrong.";
};

const codeOf = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null && "code" in e && typeof e.code === "string"
    ? e.code
    : undefined;

/**
 * Explain a failure for the person who hit it.
 *
 * @param e - Whatever was thrown.
 * @returns A sentence, and whether it was a refusal by the person or by the contract.
 */
export function explain(e: unknown): Explained {
  const raw = textOf(e);
  const code = codeOf(e);
  if (
    code === "Rejected" ||
    code === "PermissionRejected" ||
    /user (rejected|denied|declined)/i.test(raw)
  ) {
    return {
      message: "You declined in your wallet. Nothing was sent.",
      declined: true,
      refusedByContract: false,
    };
  }
  // A converted payment whose quote lapsed before it landed: the contract refused it on chain.
  if (raw.includes("FailFallible") && raw.includes("settle_invoice_converted")) {
    return {
      message:
        "The NIGHT price expired before the payment reached the chain, so it was refused and the invoice is still unpaid. Pay again for a fresh price.",
      declined: false,
      refusedByContract: true,
    };
  }
  const assert = ASSERT.exec(raw);
  if (assert?.[1]) {
    const reason = assert[1].trim();
    return {
      message: `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`.replace(/\.\.$/, "."),
      declined: false,
      refusedByContract: true,
    };
  }
  if (code === "Disconnected") {
    return {
      message: "Your wallet disconnected. Connect again and retry.",
      declined: false,
      refusedByContract: false,
    };
  }
  if (/failed to fetch|networkerror|load failed|ECONNREFUSED/i.test(raw)) {
    return {
      message:
        "A network service did not answer. Check your connection, or that the network is up, and retry.",
      declined: false,
      refusedByContract: false,
    };
  }
  if (/prover key|verifier key|zkir|contract-manifest/i.test(raw)) {
    return {
      message:
        "The proving keys for this contract are not available on this site, so the proof cannot be made.",
      declined: false,
      refusedByContract: false,
    };
  }
  const trimmed = raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
  return { message: trimmed, declined: false, refusedByContract: false };
}

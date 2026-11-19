// Delivers one webhook over HTTP(S).
//
// Built on `node:http` and `node:https` rather than `fetch` for one reason:
// the socket's own `lookup` hook runs on the address the name resolves to, at
// connect time, so a hostname that passed the URL check but resolves to a
// private address is refused before a byte is sent. With `fetch` the check and
// the connection would resolve the name separately and could disagree.

import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

import { isPublicAddress } from "./url-policy.ts";

/** What the dispatcher asks a deliverer to send. */
export interface DeliveryRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
}

/** The receiver's answer. Any status counts as an answer; only the dispatcher judges it. */
export interface DeliveryResponse {
  readonly status: number;
}

/** Sends a webhook. Rejects when no answer was obtained. */
export interface Deliverer {
  /**
   * Send a webhook.
   *
   * @param request - The address, headers, body and timeout.
   * @returns The receiver's answer.
   * @throws {Error} When no answer was obtained.
   */
  deliver(request: DeliveryRequest): Promise<DeliveryResponse>;
}

/** The destination resolved to an address the policy forbids. */
export class BlockedDestinationError extends Error {
  /**
   * Create the error.
   *
   * @param host - The name that was being connected to.
   * @param address - The address it resolved to.
   */
  constructor(host: string, address: string) {
    super(`${host} resolves to ${address}, which is not a public address`);
    this.name = "BlockedDestinationError";
  }
}

/** Options for {@link HttpDeliverer}. */
export interface HttpDelivererOptions {
  /** Development only: allow destinations on private networks. */
  readonly allowPrivateTargets: boolean;
}

/** The production deliverer. */
export class HttpDeliverer implements Deliverer {
  readonly #allowPrivate: boolean;

  /**
   * Create a deliverer.
   *
   * @param options - Whether private destinations are allowed.
   */
  constructor(options: HttpDelivererOptions) {
    this.#allowPrivate = options.allowPrivateTargets;
  }

  /** @inheritdoc */
  deliver(req: DeliveryRequest): Promise<DeliveryResponse> {
    const url = new URL(req.url);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    // An IP literal never reaches the socket's lookup, so it is judged here.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!this.#allowPrivate && isIP(host) !== 0 && !isPublicAddress(host)) {
      return Promise.reject(new BlockedDestinationError(host, host));
    }
    const guarded = ((hostname, options, callback) => {
      dnsLookup(hostname, options, (error, address, family) => {
        if (error) {
          callback(error, address, family);
          return;
        }
        // Node asks for every address when it may try several, so each is checked.
        const resolved = Array.isArray(address) ? address.map((a) => a.address) : [address];
        const refused = this.#allowPrivate ? undefined : resolved.find((a) => !isPublicAddress(a));
        if (refused !== undefined) {
          callback(new BlockedDestinationError(hostname, refused), "", 4);
          return;
        }
        callback(null, address, family);
      });
    }) as LookupFunction;

    return new Promise<DeliveryResponse>((resolve, reject) => {
      const outgoing = send(
        url,
        {
          method: "POST",
          headers: { ...req.headers, "Content-Length": String(Buffer.byteLength(req.body)) },
          lookup: guarded,
          agent: false,
          timeout: req.timeoutMs,
        },
        (response) => {
          // The answer is the status. The body is never read, and the socket is
          // closed so a receiver cannot hold it open by trickling bytes.
          response.destroy();
          resolve({ status: response.statusCode ?? 0 });
        },
      );
      outgoing.on("timeout", () =>
        outgoing.destroy(new Error(`no answer within ${String(req.timeoutMs)} ms`)),
      );
      outgoing.on("error", reject);
      outgoing.end(req.body);
    });
  }
}

// Where a webhook may be sent.
//
// A merchant chooses the URL, and the backend makes the request, so the URL is
// a way to aim this server at things it can reach and the merchant cannot:
// cloud metadata endpoints, other services on a private network, itself. The
// policy refuses every non-public destination. It is checked twice: here, on
// the URL as written, and again by the delivery socket on the address the name
// actually resolves to, which is what defeats a DNS name that points inward.

import { BlockList, isIP } from "node:net";

import { parseUrl } from "../domain/schemas.ts";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

const INTERNAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
  ".corp",
  ".intranet",
];

/**
 * Whether an IP address is one the open internet could be reached at.
 *
 * @param address - An IPv4 or IPv6 literal.
 * @returns False for private, loopback, link-local, multicast, reserved and
 *   documentation ranges, and for IPv6 addresses that embed one of them.
 */
export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    // ::ffff:a.b.c.d is an IPv4 address in IPv6 clothing.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return !blocked.check(mapped[1], "ipv4");
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
    if (mappedHex?.[1] && mappedHex[2]) {
      const hi = Number.parseInt(mappedHex[1], 16);
      const lo = Number.parseInt(mappedHex[2], 16);
      return !blocked.check(
        `${String(hi >> 8)}.${String(hi & 255)}.${String(lo >> 8)}.${String(lo & 255)}`,
        "ipv4",
      );
    }
    return !blocked.check(address, "ipv6");
  }
  return false;
};

/** Options for {@link checkWebhookUrl}. */
export interface WebhookPolicyOptions {
  /** Development only: allow http and private destinations. */
  readonly allowPrivateTargets: boolean;
}

/**
 * Check a webhook URL against the policy.
 *
 * @param value - The URL as the merchant wrote it.
 * @param options - Whether private destinations are allowed.
 * @returns A reason the URL is refused, or undefined when it is acceptable.
 */
export const checkWebhookUrl = (
  value: string,
  options: WebhookPolicyOptions,
): string | undefined => {
  const parsed = parseUrl(value);
  if ("reason" in parsed) return parsed.reason;
  const { url } = parsed;
  if (options.allowPrivateTargets) return undefined;
  if (url.protocol !== "https:") return "must use https";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) !== 0)
    return isPublicAddress(host) ? undefined : "must not point at a private or reserved address";
  if (
    host === "localhost" ||
    INTERNAL_SUFFIXES.some((s) => host.endsWith(s)) ||
    !host.includes(".")
  ) {
    return "must be a public host name";
  }
  return undefined;
};

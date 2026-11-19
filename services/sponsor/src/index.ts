// The sponsor as a library, so a test or another process that already holds a
// wallet can build one without the HTTP entry point. Only `main.ts` and
// `fund.ts` open a wallet.

export { deployedPayContract, readConfig, type SponsorConfig, sponsorSeed } from "./config.ts";
export {
  checkFee,
  checkTransaction,
  DEFAULT_RATE_LIMIT,
  DEFAULT_SPONSORED_CIRCUITS,
  type PolicyDecision,
  type RateLimitConfig,
  type RateLimitDecision,
  RateLimiter,
  type SponsorPolicy,
} from "./policy.ts";
export {
  type BucketOptions,
  createSponsorServer,
  rateLimitBucket,
  sanitizeLabel,
  type ServerOptions,
} from "./server.ts";
export {
  type CallerIdentity,
  type SponsorLogEntry,
  SponsorService,
  type SponsorServiceOptions,
  type SponsorSigner,
} from "./service.ts";
export { facadeSigner } from "./signer.ts";

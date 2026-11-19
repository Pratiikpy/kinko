// Merchants, their API keys and their webhook configuration.

import type { Config } from "../config.ts";
import { badRequest, conflict, notFound, unauthorized } from "../http/errors.ts";
import type { ApiKeyRecord, MerchantRecord, Store } from "../store/store.ts";
import { checkWebhookUrl } from "../webhooks/url-policy.ts";
import {
  API_KEY_MARKER,
  generateApiKey,
  generateWebhookSecret,
  newId,
  sha256Hex,
  type Vault,
} from "./crypto.ts";
import type { Clock } from "./events.ts";

/** A merchant as the API shows it. The webhook secret is never part of it. */
export interface MerchantView {
  readonly id: string;
  readonly name: string;
  readonly webhookUrl: string | null;
  readonly createdAt: string;
}

/** An API key as the API lists it. Only the prefix is shown, never the key. */
export interface ApiKeyView {
  readonly id: string;
  readonly prefix: string;
  readonly label: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

/** Who a request authenticated as. */
export interface Principal {
  readonly merchant: MerchantRecord;
  readonly apiKey: ApiKeyRecord;
}

/** What registration hands back. The key and the secret are shown this once. */
export interface Registration {
  readonly merchant: MerchantView;
  readonly apiKey: ApiKeyView & { readonly key: string };
  readonly webhookSecret: string;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * Project a merchant record for the API.
 *
 * @param m - The stored merchant.
 * @returns The merchant without its sealed secret.
 */
export const merchantView = (m: MerchantRecord): MerchantView => ({
  id: m.id,
  name: m.name,
  webhookUrl: m.webhookUrl,
  createdAt: new Date(m.createdAt).toISOString(),
});

/**
 * Project an API key record for the API.
 *
 * @param k - The stored key record.
 * @returns The key's prefix, label and dates, never the key or its hash.
 */
export const apiKeyView = (k: ApiKeyRecord): ApiKeyView => ({
  id: k.id,
  prefix: k.prefix,
  label: k.label,
  createdAt: new Date(k.createdAt).toISOString(),
  lastUsedAt: iso(k.lastUsedAt),
  revokedAt: iso(k.revokedAt),
});

/** How often `lastUsedAt` is written: once a minute per key, not once a request. */
const TOUCH_INTERVAL_MS = 60_000;

/** Registration, authentication and webhook settings. */
export class MerchantService {
  readonly #store: Store;
  readonly #vault: Vault;
  readonly #clock: Clock;
  readonly #config: Pick<Config, "webhooks">;

  /**
   * Create the service.
   *
   * @param store - Where merchants and keys are kept.
   * @param vault - Seals webhook secrets at rest.
   * @param clock - The source of time, in milliseconds.
   * @param config - The webhook policy settings.
   */
  constructor(store: Store, vault: Vault, clock: Clock, config: Pick<Config, "webhooks">) {
    this.#store = store;
    this.#vault = vault;
    this.#clock = clock;
    this.#config = config;
  }

  #checkUrl(url: string): void {
    const refused = checkWebhookUrl(url, {
      allowPrivateTargets: this.#config.webhooks.allowPrivateTargets,
    });
    if (refused)
      throw badRequest(`Invalid request. webhookUrl ${refused}.`, [
        { path: "webhookUrl", message: refused },
      ]);
  }

  /**
   * Register a merchant with a first API key and a webhook secret.
   *
   * @param input - The merchant's name and optional webhook URL.
   * @param input.name - The merchant's display name.
   * @param input.webhookUrl - Where webhooks go, or null for none.
   * @returns The merchant, the key and the secret; the last two are never shown again.
   */
  register(input: { name: string; webhookUrl?: string | null | undefined }): Registration {
    if (input.webhookUrl) this.#checkUrl(input.webhookUrl);
    const now = this.#clock();
    const secret = generateWebhookSecret();
    const merchant: MerchantRecord = {
      id: newId("mer"),
      name: input.name,
      webhookUrl: input.webhookUrl ?? null,
      webhookSecretSealed: this.#vault.seal(secret),
      createdAt: now,
    };
    const generated = generateApiKey();
    const key: ApiKeyRecord = {
      id: newId("key", 8),
      merchantId: merchant.id,
      prefix: generated.prefix,
      hash: generated.hash,
      label: "default",
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    };
    this.#store.transaction(() => {
      this.#store.insertMerchant(merchant);
      this.#store.insertApiKey(key);
    });
    return {
      merchant: merchantView(merchant),
      apiKey: { ...apiKeyView(key), key: generated.key },
      webhookSecret: secret,
    };
  }

  /**
   * Resolve a bearer credential to a merchant.
   *
   * @param header - The `Authorization` header value, if any.
   * @returns The merchant and the key used.
   * @throws {ApiError} 401 for a missing, malformed, unknown or revoked key.
   */
  authenticate(header: string | undefined): Principal {
    const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
    const presented = match?.[1];
    if (!presented?.startsWith(API_KEY_MARKER)) throw unauthorized();
    const apiKey = this.#store.findApiKeyByHash(sha256Hex(presented));
    const refusal = "That API key is not valid. It may have been revoked.";
    if (apiKey === undefined) throw unauthorized(refusal);
    if (apiKey.revokedAt !== null) throw unauthorized(refusal);
    const merchant = this.#store.getMerchant(apiKey.merchantId);
    if (!merchant) throw unauthorized();
    const now = this.#clock();
    if (apiKey.lastUsedAt === null || now - apiKey.lastUsedAt > TOUCH_INTERVAL_MS)
      this.#store.touchApiKey(apiKey.id, now);
    return { merchant, apiKey };
  }

  /**
   * Change a merchant's name or webhook URL.
   *
   * @param merchantId - Whose settings to change.
   * @param patch - The fields to change; `webhookUrl: null` turns webhooks off.
   * @param patch.name - A new display name.
   * @param patch.webhookUrl - A new webhook address, or null to turn webhooks off.
   * @returns The updated merchant.
   * @throws {ApiError} 400 for a webhook URL the policy refuses; 404 when the merchant does not exist.
   */
  update(
    merchantId: string,
    patch: { name?: string | undefined; webhookUrl?: string | null | undefined },
  ): MerchantRecord {
    if (patch.webhookUrl) this.#checkUrl(patch.webhookUrl);
    const next: { name?: string; webhookUrl?: string | null } = {};
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.webhookUrl !== undefined) next.webhookUrl = patch.webhookUrl;
    const updated = this.#store.updateMerchant(merchantId, next);
    if (!updated) throw notFound("That merchant does not exist.");
    return updated;
  }

  /**
   * Draw an additional API key.
   *
   * @param merchantId - The key's owner.
   * @param label - A name to tell keys apart.
   * @returns The key record and the key itself, shown once.
   */
  createKey(merchantId: string, label: string | undefined): { record: ApiKeyRecord; key: string } {
    const generated = generateApiKey();
    const record: ApiKeyRecord = {
      id: newId("key", 8),
      merchantId,
      prefix: generated.prefix,
      hash: generated.hash,
      label: label ?? null,
      createdAt: this.#clock(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.#store.insertApiKey(record);
    return { record, key: generated.key };
  }

  /**
   * List a merchant's keys, revoked ones included.
   *
   * @param merchantId - The keys' owner.
   * @returns The key records, oldest first.
   */
  listKeys(merchantId: string): ApiKeyRecord[] {
    return this.#store.listApiKeys(merchantId);
  }

  /**
   * Revoke a key. The last active key cannot be revoked: a merchant who did so
   * could never authenticate again to make a new one.
   *
   * @param merchantId - The key's owner.
   * @param keyId - The key to revoke.
   * @throws {ApiError} 404 when there is no such active key; 409 for the last one.
   */
  revokeKey(merchantId: string, keyId: string): void {
    this.#store.transaction(() => {
      const keys = this.#store.listApiKeys(merchantId);
      const target = keys.find((k) => k.id === keyId && k.revokedAt === null);
      if (!target) throw notFound("There is no active API key with that id.");
      if (keys.filter((k) => k.revokedAt === null).length === 1) {
        throw conflict(
          "This is the only active API key. Create another before revoking it, or you would lock yourself out.",
        );
      }
      this.#store.revokeApiKey(merchantId, keyId, this.#clock());
    });
  }

  /**
   * Replace the webhook signing secret.
   *
   * @param merchantId - Whose secret to replace.
   * @returns The new secret, shown once.
   * @throws {ApiError} 404 when the merchant does not exist.
   */
  rotateWebhookSecret(merchantId: string): string {
    const secret = generateWebhookSecret();
    const updated = this.#store.updateMerchant(merchantId, {
      webhookSecretSealed: this.#vault.seal(secret),
    });
    if (!updated) throw notFound("That merchant does not exist.");
    return secret;
  }
}

// What route handlers are given. Handlers hold no state of their own: they
// validate input, call a service and shape the answer.

import type { Assistant } from "../assistant.ts";
import type { ChainReader } from "../chain/reader.ts";
import type { Config } from "../config.ts";
import type { Vault } from "../domain/crypto.ts";
import type { Clock, EventRecorder } from "../domain/events.ts";
import type { MerchantService } from "../domain/merchants.ts";
import type { SessionService } from "../domain/sessions.ts";
import type { TelegramService } from "../domain/telegram.ts";
import type { Logger } from "../log.ts";
import type { Oracle } from "../oracle/oracle.ts";
import type { Store } from "../store/store.ts";
import type { Watcher } from "../watcher.ts";
import type { WebhookDispatcher } from "../webhooks/dispatcher.ts";

/** The services and settings every route group may use. */
export interface RouteDeps {
  readonly config: Config;
  readonly store: Store;
  readonly clock: Clock;
  readonly log: Logger;
  readonly vault: Vault;
  readonly merchants: MerchantService;
  readonly sessions: SessionService;
  readonly telegram: TelegramService;
  readonly events: EventRecorder;
  readonly watcher: Watcher;
  readonly dispatcher: WebhookDispatcher;
  readonly chain: ChainReader;
  /** Undefined when no oracle key is configured. */
  readonly oracle: Oracle | undefined;
  readonly assistant: Assistant;
}

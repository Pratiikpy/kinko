// Shared machinery for the live suite: the repository's local environment,
// one wallet registry per test file, and a page per party with problem
// listeners attached before the first navigation.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CardWallet } from "@kinko/card";
import {
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  expect,
  type Page,
  type Response,
} from "@playwright/test";
import { getMidnightNodeConfig, WalletRegistry } from "@sig-net/midnight-contract-deploy";

import { injectDevWallet } from "./bridge.ts";
import { DevWallet } from "./dev-wallet.ts";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1] ?? "", m[2] ?? ""]),
  );
}

/** The stack's environment: the root .env (or the file KINKO_ENV_FILE names), then the process environment. */
export const ENV: Record<string, string | undefined> = {
  ...readEnv(`${ROOT}${process.env.KINKO_ENV_FILE ?? ".env"}`),
  ...process.env,
};

/** The deployment record written by `yarn workspace @kinko/deploy deploy`, for the env's network. */
export const DEPLOYMENT = JSON.parse(
  readFileSync(`${ROOT}deployments/${ENV.NETWORK_ID ?? "undeployed"}.json`, "utf8"),
) as { kusdColor: string; pay: { contractAddress: string } };

/**
 * A seed from the environment.
 *
 * @param name - The variable.
 * @returns Its value.
 * @throws {Error} When it is not set.
 */
export function seed(name: string): string {
  const v = ENV[name];
  if (!v) throw new Error(`${name} is not set in the root .env`);
  return v;
}

/** The network the run targets: the env file's NETWORK_ID, the local stack when it names none. */
export const NETWORK = ENV.NETWORK_ID ?? "undeployed";

/** Where this network's screenshots go, beside Playwright's own results for the run. */
export const RESULTS = `dist/e2e-live-results${ENV.NETWORK_ID && ENV.NETWORK_ID !== "undeployed" ? `-${ENV.NETWORK_ID}` : ""}`;

/** Opens wallets against the stack and closes them together. */
export function registry(): WalletRegistry {
  return new WalletRegistry(getMidnightNodeConfig(ENV), ENV);
}

/**
 * Context options that record the party's window when `KINKO_RECORD` is set, for the demo
 * video: one file per party under dist/demo-video/<label>.
 *
 * @param label - The party's name.
 * @returns The options, empty when not recording.
 */
export function recording(label: string): {
  recordVideo?: { dir: string; size: { width: number; height: number } };
} {
  return process.env.KINKO_RECORD
    ? { recordVideo: { dir: `dist/demo-video/${label}`, size: { width: 1440, height: 900 } } }
    : {};
}

const opened: BrowserContext[] = [];

/**
 * Close every party's browser context. A recording is written out only when its context
 * closes, so specs call this when they finish.
 */
export async function closeParties(): Promise<void> {
  await Promise.all(opened.splice(0).map(settleAndClose));
  const cards = [...openedCards.values()];
  openedCards.clear();
  await Promise.all(cards.map(async (card) => (await card.catch(() => undefined))?.stop()));
}

/**
 * Close a context so its recording keeps its last screen: the recorder only takes a frame
 * when the page paints, so the page is nudged and held before closing.
 *
 * @param context - The context.
 */
export async function settleAndClose(context: BrowserContext): Promise<void> {
  for (const page of context.pages()) {
    await page.mouse.move(2, 2).catch(() => undefined);
    await page.waitForTimeout(1_500).catch(() => undefined);
  }
  await context.close();
}

/**
 * Whether a console message is the hosted node's connection coming or going, which is the
 * network's weather and not the product's behaviour: polkadot-js logs a close, a dropped or
 * not-yet-open socket at error level and then reconnects by itself, and notes at warning
 * level that a node without a newer metadata call is read with the older one; the browser warns when a
 * socket is closed before it opened, as a wallet's liveness check does when its page goes
 * away, or is interrupted by a page load; and Firefox reports the node host's Cloudflare
 * load-balancer cookie as rejected in a cross-site context.
 *
 * @param text - The console message, with the text of any error it carries ({@link consoleText}).
 * @returns True for those.
 */
export function isNodeSocketNoise(text: string): boolean {
  const closed = /disconnected from wss?:\/\/\S+: 100[06]:: (?:Normal|Abnormal) Closure/.test(text);
  const notConnected = /(?:RPC-CORE|API\/INIT|API-WS): .*WebSocket is not connected/.test(text);
  const metadataFallback =
    /API\/INIT: error with state_call::Metadata_metadata_(?:at_)?versions?, rpc::state::get_metadata will be used/.test(
      text,
    );
  const chromiumClosed =
    /WebSocket connection to '[^']*(?:rpc\.|:9944)[^']*' failed: WebSocket is closed before the connection is established/.test(
      text,
    );
  const firefoxSocket =
    /(?:can’t establish a connection to the server at|The connection to) wss:\/\/(?:rpc\.|[^\s/]*blockfrost\.io)/.test(
      text,
    );
  const loadBalancerCookie =
    text.includes("Cookie “__cflb” has been rejected") && text.includes("blockfrost.io");
  return (
    closed ||
    notConnected ||
    metadataFallback ||
    chromiumClosed ||
    firefoxSocket ||
    loadBalancerCookie
  );
}

/**
 * A console message's full text. Firefox reports a logged Error as just its name, so a
 * polkadot-js socket error reads "API/INIT: Error" with the reason held in an argument; this
 * adds each Error argument's name and message so the message can be judged and reported.
 *
 * @param m - The console message.
 * @returns The message text, with the text of any Error arguments.
 */
export async function consoleText(m: ConsoleMessage): Promise<string> {
  const errors = await Promise.all(
    m
      .args()
      .map((a) =>
        a.evaluate((x) => (x instanceof Error ? `${x.name}: ${x.message}` : "")).catch(() => ""),
      ),
  );
  const detail = errors.filter((e) => e !== "").join(" | ");
  return detail === "" ? m.text() : `${m.text()} | ${detail}`;
}

/**
 * Collect a page's console problems: its errors, and its warnings when asked, except the
 * node connection's weather ({@link isNodeSocketNoise}). Each is kept in `problems` with its
 * full text and printed.
 *
 * @param page - The page.
 * @param label - The party's name in logs.
 * @param problems - Where the problems collect.
 * @param warnings - Whether warnings count as problems.
 */
export function watchConsole(
  page: Page,
  label: string,
  problems: string[],
  warnings: boolean,
): void {
  page.on("console", (m) => {
    if (m.type() !== "error" && !(warnings && m.type() === "warning")) return;
    const work: Promise<void> = consoleText(m)
      .then((text) => {
        if (isNodeSocketNoise(text)) return;
        problems.push(`[${label}] console ${m.type()}: ${text}`);
        console.log(`[${label}] console ${m.type()}: ${text}`);
      })
      .catch(() => undefined)
      .finally(() => {
        resolving.delete(work);
      });
    resolving.add(work);
  });
}

/** Console messages whose full text is still being read. */
const resolving = new Set<Promise<void>>();

/**
 * Wait until every console message seen so far has been read and judged, so a test that looks at a
 * party's problems sees all of them, including a message logged a moment ago.
 */
export async function consoleSettled(): Promise<void> {
  await Promise.all([...resolving]);
}

/** One party: a wallet and a page in its own browser context. */
export interface Party {
  readonly wallet: DevWallet;
  readonly page: Page;
  readonly problems: string[];
}

/**
 * Open a party with a fresh, isolated browser context.
 *
 * @param browser - The browser.
 * @param reg - The registry that owns the wallet.
 * @param label - The party's name in logs and screenshots.
 * @param walletSeed - The wallet seed.
 * @returns The party.
 */
export async function party(
  browser: Browser,
  reg: WalletRegistry,
  label: string,
  walletSeed: string,
): Promise<Party> {
  const wallet = await DevWallet.open(reg, label, walletSeed);
  const context = await browser.newContext(recording(label));
  opened.push(context);
  const page = await context.newPage();
  const problems: string[] = [];
  watchConsole(page, label, problems, true);
  page.on("pageerror", (e) => problems.push(`[${label}] pageerror: ${e.message}`));
  // Proving is the slow, opaque step: name every key fetch and proof request with its timing.
  const started = new Map<string, number>();
  const watched = (url: string) => url.includes("/zk/") || url.includes(":6300/");
  page.on("request", (r) => {
    if (watched(r.url())) {
      started.set(r.url(), Date.now());
      console.log(`[${label}] -> ${r.method()} ${r.url()}`);
    }
  });
  page.on("requestfinished", (r) => {
    if (watched(r.url())) {
      const ms = Date.now() - (started.get(r.url()) ?? Date.now());
      console.log(`[${label}] <- ${r.url()} in ${String(ms)} ms`);
    }
  });
  page.on("response", (r) => {
    if (r.status() >= 400) {
      problems.push(`[${label}] HTTP ${String(r.status())}: ${r.request().method()} ${r.url()}`);
      console.log(`[${label}] HTTP ${String(r.status())}: ${r.request().method()} ${r.url()}`);
    }
  });
  page.on("requestfailed", (r) =>
    problems.push(`[${label}] requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`),
  );
  await injectDevWallet(page, wallet, `${label} wallet`);
  return { wallet, page, problems };
}

/**
 * Connect a party's page to its wallet from the app's own connect button.
 *
 * @param p - The party.
 */
export async function connect(p: Party): Promise<void> {
  await p.page
    .getByRole("button", { name: /^Connect/ })
    .first()
    .click();
  await p.page.getByRole("button", { name: new RegExp(`${p.wallet.label} wallet`) }).click();
}

/**
 * Save a full-page screenshot under the run's output directory.
 *
 * @param p - The party.
 * @param name - The file's name.
 */
export async function shot(p: Party, name: string): Promise<void> {
  await p.page.screenshot({ path: `${RESULTS}/shots/${name}.png`, fullPage: true });
}

/**
 * Diagnose a stalled step: if `text` has not appeared within `ms`, pause the
 * page's JavaScript and print where it is waiting, with the heap size.
 *
 * @param page - The page.
 * @param text - What the step shows when it finishes.
 * @param ms - How long to give it first.
 */
export async function dumpIfStalled(page: Page, text: string, ms: number): Promise<void> {
  try {
    await page.getByText(text).waitFor({ timeout: ms });
    return;
  } catch {
    // Stalled: look inside.
  }
  const cdp = await page.context().newCDPSession(page);
  const metrics = await cdp.send("Performance.getMetrics").catch(() => ({ metrics: [] }));
  await cdp.send("Performance.enable");
  const heap = (await cdp.send("Performance.getMetrics")).metrics.find(
    (m) => m.name === "JSHeapUsedSize",
  );
  console.log(
    `STALL heap ${String(Math.round((heap?.value ?? 0) / 1e6))} MB`,
    metrics.metrics.length,
  );
  await cdp.send("Debugger.enable");
  const paused = new Promise<unknown>((resolve) => {
    cdp.once("Debugger.paused", resolve);
  });
  await cdp.send("Debugger.pause");
  const event = (await Promise.race([
    paused,
    new Promise((resolve) =>
      setTimeout(() => {
        resolve(null);
      }, 10_000),
    ),
  ])) as {
    callFrames?: { functionName: string; url: string; location: { lineNumber: number } }[];
  } | null;
  if (!event) {
    console.log("STALL: the page is idle, waiting on a promise that never settles");
  } else {
    for (const f of event.callFrames ?? []) {
      console.log(
        `STALL at ${f.functionName || "(anonymous)"} ${f.url}:${String(f.location.lineNumber)}`,
      );
    }
  }
  await cdp.send("Debugger.resume").catch(() => undefined);
}

/**
 * Wait for a step's success text, but stop at once if the app reports the
 * step failed: a failed proof or a refused call ends the wait with its reason.
 *
 * @param p - The party.
 * @param text - What the step shows when it succeeds.
 * @param timeout - How long to allow, in milliseconds.
 */
export async function finished(p: Party, text: string, timeout = 15 * 60_000): Promise<void> {
  const before = p.problems.length;
  await expect
    .poll(
      async () =>
        (await p.page.getByText(text).first().isVisible()) ||
        p.problems.slice(before).some((x) => x.includes("[kinko] the action failed")),
      { timeout, intervals: [2_000] },
    )
    .toBe(true);
  const reasons = p.problems.slice(before).join(" | ");
  await expect(p.page.getByText(text).first(), reasons).toBeVisible();
}

/**
 * Fail if any party saw a console error, page error or failed request.
 *
 * @param parties - The parties.
 */
export async function expectNoProblems(...parties: Party[]): Promise<void> {
  await consoleSettled();
  expect(parties.flatMap((p) => p.problems)).toEqual([]);
}

/**
 * How long a balance may take to show on this network. A wallet that has never synced replays
 * the chain's whole history, which is seconds on the local stack and about fifteen minutes on
 * a public network.
 */
export const SYNC_MS = (ENV.NETWORK_ID ?? "undeployed") === "undeployed" ? 5 * 60_000 : 40 * 60_000;

/**
 * How long a card made through Kinko may take to show its balance. It starts from the tree the
 * snapshot service published at its birth, so it replays only what happened since, seconds on the
 * local stack and under a minute on a public network, not the chain's whole history.
 */
export const OPEN_MS = (ENV.NETWORK_ID ?? "undeployed") === "undeployed" ? 90_000 : 5 * 60_000;

/**
 * Wait for the response that gave a card its starting tree, the app's request to the snapshot
 * service for the card's birth. Start it before the card is opened.
 *
 * @param page - The page that opens the card.
 * @returns The response, for the test to check it was served.
 */
export function snapshotResponse(page: Page): Promise<Response> {
  return page.waitForResponse((r) => r.url().includes("/v1/card-snapshot?birth="), {
    timeout: OPEN_MS,
  });
}

/** What a card's birth looks like: an event id and the first digits of the chain's identity. */
export const BIRTH = /^[0-9]+-[0-9a-f]{8}$/;

const openedCards = new Map<string, Promise<CardWallet>>();

/** Where the snapshot service answers: its port in the env file, else the network's usual one. */
const SNAPSHOTS_URL = `http://127.0.0.1:${ENV.SNAPSHOTS_PORT ?? ((ENV.NETWORK_ID ?? "undeployed") === "undeployed" ? "3400" : "4400")}`;

/**
 * The snapshot a card starts from, as the app fetches it, unless the run asks for the chain to be
 * replayed in full (`KINKO_LIVE_FULL_REPLAY=1`), the check that a card started from a snapshot
 * reads what a card replayed from the first event reads.
 *
 * @param birth - The card's birth, from its link.
 * @returns The snapshot, or undefined to replay the chain.
 */
async function startingSnapshot(birth: string | undefined): Promise<string | undefined> {
  if (birth === undefined || process.env.KINKO_LIVE_FULL_REPLAY === "1") return undefined;
  const response = await fetch(`${SNAPSHOTS_URL}/v1/card-snapshot?birth=${birth}`);
  if (!response.ok) return undefined;
  return ((await response.json()) as { snapshot?: string }).snapshot;
}

/**
 * A card's balance as the chain has it, read by opening the card from Node: the source of
 * truth behind what a page says the card holds. A card is opened once and kept, so only the
 * first read pays for a sync; `closeParties` stops it. Given the card's birth it starts from the
 * snapshot service's tree, as the app does; without one, or with `KINKO_LIVE_FULL_REPLAY=1`, it
 * replays the chain from the first event.
 *
 * @param entropy - The card's entropy.
 * @param tokenType - Raw token type, hex.
 * @param birth - The card's birth, from its link.
 * @returns Base units.
 */
export async function cardBalanceOnChain(
  entropy: Uint8Array,
  tokenType: string,
  birth?: string,
): Promise<bigint> {
  const key = Buffer.from(entropy).toString("hex");
  let card = openedCards.get(key);
  if (!card) {
    const config = getMidnightNodeConfig(ENV);
    const snapshot = await startingSnapshot(birth);
    card = CardWallet.open(
      entropy,
      {
        networkId: config.networkId,
        indexerHttpUrl: config.indexerUrl,
        indexerWsUrl: config.indexerWsUrl,
        proofServerUrl: config.proofServerUrl,
        nodeUrl: config.nodeUrl,
      },
      { kind: "wallet", pay: () => Promise.reject(new Error("this card is only read")) },
      snapshot === undefined ? {} : { snapshot },
    );
    openedCards.set(key, card);
  }
  return (await card).balance(tokenType);
}

/**
 * The value a Copyable shows, read from its button's accessible name.
 *
 * @param page - The page.
 * @param label - The Copyable's label.
 * @returns The copied value.
 */
export async function copied(page: Page, label: string): Promise<string> {
  const name = await page
    .getByRole("button", { name: new RegExp(`^Copy ${label}:`) })
    .first()
    .getAttribute("aria-label");
  return (name ?? "").replace(new RegExp(`^Copy ${label}:\\s*`), "");
}

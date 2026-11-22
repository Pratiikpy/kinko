// Renders the README's images from docs/readme/src/*.html with the repository's own Playwright and
// the app's fonts, so they match the product's look.
//
//   node docs/readme/render.mjs [--usdc 1250.40 --kusd 1250.00 --cov 100.03%]
//
// The cover shows the live backing figures: pass what the backing page reads from the deployed
// vault (the relayer's /backing report gives both). Output goes next to this file.

import { chromium } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : undefined))
    .filter(Boolean),
);

const jobs = [
  {
    html: "cover.html",
    out: "cover.png",
    width: 1600,
    height: 640,
    query: new URLSearchParams({
      usdc: args.usdc ?? "0",
      kusd: args.kusd ?? "0",
      cov: args.cov ?? "",
    }).toString(),
  },
  { html: "architecture.html", out: "architecture.png", width: 1600, height: 984, query: "" },
];

const browser = await chromium.launch();
try {
  for (const job of jobs) {
    const context = await browser.newContext({
      viewport: { width: job.width, height: job.height },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const url = `${pathToFileURL(resolve(here, "src", job.html)).href}${job.query ? `?${job.query}` : ""}`;
    await page.goto(url, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(here, job.out) });
    await context.close();
    console.log(`wrote docs/readme/${job.out}`);
  }
} finally {
  await browser.close();
}

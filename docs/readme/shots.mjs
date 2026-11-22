// Captures the README's screenshots from a running Kinko build, with no mocked data:
// the backing page reads the deployed vault's USDC and KUSD supply through the relayer.
//
//   node docs/readme/shots.mjs [http://127.0.0.1:4174]
//
// Start the preprod build first (see "Run it on preprod" in the README). Output goes next to
// this file. The pages need no wallet.

import { chromium } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] ?? "http://127.0.0.1:4174";

const jobs = [
  { out: "shot-landing.png", path: "/", theme: "light", width: 1440, height: 900, full: false },
  { out: "shot-landing-dark.png", path: "/", theme: "dark", width: 1440, height: 900, full: false },
  {
    out: "shot-backing.png",
    path: "/backing",
    theme: "light",
    width: 1440,
    height: 1500,
    full: false,
    wait: "Fully backed",
  },
  {
    out: "shot-examine.png",
    path: "/examine",
    theme: "light",
    width: 1440,
    height: 900,
    full: false,
  },
  {
    out: "shot-phone.png",
    path: "/",
    theme: "light",
    width: 390,
    height: 1500,
    full: false,
    mobile: true,
  },
];

const browser = await chromium.launch();
try {
  for (const job of jobs) {
    const context = await browser.newContext({
      viewport: { width: job.width, height: job.height },
      deviceScaleFactor: 2,
      isMobile: job.mobile ?? false,
    });
    await context.addInitScript((theme) => {
      try {
        localStorage.setItem("kinko:theme", theme);
      } catch {
        /* the page still renders */
      }
    }, job.theme);
    const page = await context.newPage();
    await page.goto(`${base}${job.path}`, { waitUntil: "networkidle" });
    if (job.wait) await page.getByText(job.wait).first().waitFor({ timeout: 90_000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(here, job.out), fullPage: job.full });
    console.log(`wrote docs/readme/${job.out}`);
    await context.close();
  }
} finally {
  await browser.close();
}

/* global console */
// Renders public/favicon.svg into the PNG icons the manifest and iOS need.
// Run with `node scripts/make-icons.mjs` after changing the seal.

import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(path.join(root, "public", "favicon.svg"), "utf8");
const out = path.join(root, "public", "icons");
mkdirSync(out, { recursive: true });

// A maskable icon keeps its mark inside the central 80% safe zone on a full-bleed ground.
const ICONS = [
  { name: "icon-192.png", size: 192, pad: 0, ground: "transparent" },
  { name: "icon-512.png", size: 512, pad: 0, ground: "transparent" },
  { name: "apple-touch-icon.png", size: 180, pad: 18, ground: "#f7f3ec" },
  { name: "icon-maskable-512.png", size: 512, pad: 76, ground: "#c23a22" },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const icon of ICONS) {
  const inner = icon.size - icon.pad * 2;
  await page.setViewportSize({ width: icon.size, height: icon.size });
  await page.setContent(
    `<html><body style="margin:0;background:${icon.ground};display:grid;place-items:center;width:${icon.size}px;height:${icon.size}px">` +
      `<div style="width:${inner}px;height:${inner}px">${svg.replace("<svg ", `<svg width="${inner}" height="${inner}" `)}</div></body></html>`,
  );
  await page.screenshot({
    path: path.join(out, icon.name),
    omitBackground: icon.ground === "transparent",
  });
  console.log(`wrote public/icons/${icon.name}`);
}
await browser.close();

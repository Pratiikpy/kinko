import { defineConfig } from "@playwright/test";

const PORT = "5190";

// One browser engine, four looks: desktop and phone width, light and dark.
export default defineConfig({
  testDir: "e2e",
  // The live suite needs the local chain stack; it has its own config.
  testIgnore: "live/**",
  outputDir: "dist/e2e-results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 4,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: "chromium",
    trace: "off",
  },
  projects: [
    {
      name: "desktop-light",
      use: { viewport: { width: 1440, height: 900 }, colorScheme: "light" },
    },
    { name: "desktop-dark", use: { viewport: { width: 1440, height: 900 }, colorScheme: "dark" } },
    {
      name: "phone-light",
      use: {
        viewport: { width: 375, height: 812 },
        colorScheme: "light",
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
    {
      name: "phone-dark",
      use: {
        viewport: { width: 375, height: 812 },
        colorScheme: "dark",
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
  ],
  webServer: {
    command: `npx vite build --mode e2e --outDir dist/e2e && npx vite preview --mode e2e --outDir dist/e2e --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 300_000,
  },
});

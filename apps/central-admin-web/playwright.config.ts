import { defineConfig, devices } from "@playwright/test";

// Offline E2E: the app is built with NEXT_PUBLIC_API_URL pointing at a host
// that never exists (localhost:4999). Every API call is answered by
// page.route mocks in e2e/fixtures.ts; any other off-origin request is aborted.
const PORT = Number(process.env.E2E_PORT || 3100);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    serviceWorkers: "block",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    {
      name: "mobile-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
  ],
  webServer: {
    // Requires a prior `NEXT_PUBLIC_API_URL=http://localhost:4999 npm run build`.
    command: `npm run start -- -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

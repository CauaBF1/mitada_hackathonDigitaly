import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: "./tests",
  testMatch: "real-dashboard.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 15000 },
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure", screenshot: "only-on-failure", channel: process.env.PLAYWRIGHT_CHANNEL || undefined },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1100 } } }],
  webServer: [
    { command: ".venv/bin/python ../scripts/e2e_backend.py", cwd: path.resolve(__dirname, "../backend"), url: "http://127.0.0.1:8001/health", timeout: 60000, reuseExistingServer: false },
    { command: "npm run start -- --port 3100", url: "http://127.0.0.1:3100", timeout: 120000, reuseExistingServer: false, env: { API_URL: "http://127.0.0.1:8001", NEXT_TELEMETRY_DISABLED: "1" } },
  ],
});

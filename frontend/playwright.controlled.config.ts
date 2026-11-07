import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import path from "node:path";

export default defineConfig({
  ...base,
  testMatch: "controlled-lifecycle.spec.ts",
  reporter: [["list"], ["json", { outputFile: "../artifacts/final/browser-controlled.json" }]],
  webServer: [
    { command: ".venv/bin/python ../scripts/e2e_controlled_backend.py", cwd: path.resolve(__dirname, "../backend"), url: "http://127.0.0.1:8001/health", timeout: 60000, reuseExistingServer: false },
    { command: "npm run start -- --port 3100", url: "http://127.0.0.1:3100", timeout: 120000, reuseExistingServer: false, env: { API_URL: "http://127.0.0.1:8001", NEXT_TELEMETRY_DISABLED: "1" } },
  ],
});

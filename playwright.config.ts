// Browser end-to-end tests against the production server (`npm run build` first).
//   npm run test:e2e

import { defineConfig } from '@playwright/test';

const PORT = 5180;
/** Set to test a running deployment instead of starting a local server (e.g. through port-forward). */
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: external ?? `http://127.0.0.1:${PORT}`,
    viewport: { width: 1000, height: 750 },
    trace: 'retain-on-failure',
  },
  webServer: external ? undefined : {
    command: 'node server/main.ts',
    url: `http://127.0.0.1:${PORT}/readyz`,
    env: { PORT: String(PORT), HOST: '127.0.0.1', COLO_CONFIG: 'examples/config.yaml', LOG_LEVEL: 'warn' },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

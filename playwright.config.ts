// Browser end-to-end tests against the production server (`npm run build` first).
//   npm run test:e2e

import { defineConfig } from '@playwright/test';

const PORT = 5180;

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1000, height: 750 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node server/main.ts',
    url: `http://127.0.0.1:${PORT}/readyz`,
    env: { PORT: String(PORT), HOST: '127.0.0.1', COLO_CONFIG: 'examples/config.yaml', LOG_LEVEL: 'warn' },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

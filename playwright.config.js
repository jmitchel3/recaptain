import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false, // persistent-context tests must not interleave
  retries: 0,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
  },
});

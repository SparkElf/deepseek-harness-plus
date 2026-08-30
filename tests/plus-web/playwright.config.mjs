import { defineConfig } from 'playwright/test'

const usesDataOpsPassword = process.env.DSH_PLUS_TEST_DATAOPS_PASSWORD !== undefined

export default defineConfig({
  testDir: '.',
  testMatch: ['plus-web.spec.mjs'],
  outputDir: '../../.cache/plus-web-system/test-results',
  globalSetup: './global-setup.mjs',
  globalTeardown: './global-teardown.mjs',
  timeout: 10 * 60_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: '../../.cache/plus-web-system/report', open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:3081',
    locale: 'zh-CN',
    viewport: { width: 1680, height: 1000 },
    acceptDownloads: true,
    trace: usesDataOpsPassword ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
})

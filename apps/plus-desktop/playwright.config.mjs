import { defineConfig } from 'playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'installer-electron.spec.mjs',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
})

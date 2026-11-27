import { defineConfig } from 'vitest/config'

export default defineConfig({
  // UI tests opt into jsdom with a per-file `@vitest-environment` docblock.
  test: { include: ['tests/**/*.test.{ts,tsx}'], environment: 'node' },
})

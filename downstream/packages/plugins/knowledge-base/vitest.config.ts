import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['tests/**/*.spec.{ts,tsx}'], exclude: ['tests/knowledge-base.spec.ts', 'tests/permissions.spec.ts'], environment: 'node' } })

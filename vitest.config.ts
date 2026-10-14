import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/integration/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30000,
          hookTimeout: 120000,
        },
      },
      {
        test: {
          // Requires `npm run local:start` (real PostgREST, Auth, Edge Functions).
          name: 'stack',
          include: ['tests/stack/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 30000,
        },
      },
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
})

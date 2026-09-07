import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main')
    }
  },
  test: {
    projects: [
      {
        resolve: {
          alias: {
            '@shared': resolve(__dirname, 'src/shared'),
            '@main': resolve(__dirname, 'src/main')
          }
        },
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node'
        }
      },
      {
        resolve: {
          alias: {
            '@shared': resolve(__dirname, 'src/shared'),
            '@main': resolve(__dirname, 'src/main')
          }
        },
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60000,
          hookTimeout: 120000,
          fileParallelism: false
        }
      }
    ]
  }
})

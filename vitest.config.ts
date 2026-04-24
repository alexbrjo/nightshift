import { defineConfig } from 'vitest/config'
// @ts-ignore - vite/vitest version compatibility workaround
import reactPlugin from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [reactPlugin()] as any,
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/shared/test-setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
  },
})

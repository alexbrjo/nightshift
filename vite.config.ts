import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          resolve: {
            alias: {
              '@shared': resolve('src/shared'),
            },
          },
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['better-sqlite3', 'chokidar', 'fsevents', 'vm2'],
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(args) {
          args.reload()
        },
        vite: {
          resolve: {
            alias: {
              '@shared': resolve('src/shared'),
            },
          },
          build: {
            outDir: 'dist-electron',
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@main': resolve('electron/main'),
      '@renderer': resolve('src/renderer'),
      '@shared': resolve('src/shared'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})

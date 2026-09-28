import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // A side-effect-free entry for the backup subsystem. The main bundle
          // already contains these modules; this one exists purely so the
          // backup tests can import the real, compiled code instead of a copy.
          'backup-under-test': resolve(__dirname, 'src/main/backup/entry.ts')
        },
        output: { entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          chatgpt: resolve(__dirname, 'src/preload/chatgpt.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react()]
  }
})

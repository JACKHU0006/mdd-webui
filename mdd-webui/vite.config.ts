import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `vite.config.ts` is evaluated by Node, but pulling in @types/node just for one env read
// is not worth the dependency. Declare the single global actually used.
declare const process: { env: Record<string, string | undefined> }

/**
 * Dev proxy target.
 *
 * Default is the mock backend, so `npm run dev:mock` works with no hardware and no extra
 * configuration. Point MDD_GATEWAY at a real gateway to develop against hardware instead.
 *
 * `secure: false` matters for the real gateway: it serves HTTPS on :8443 with a self-signed
 * certificate, which Node would otherwise reject.
 */
const target = process.env.MDD_GATEWAY || 'http://127.0.0.1:8788'

export default defineConfig({
  // The control plane serves the built SPA from /assets plus an index.html fallback, and
  // Cloudflare Pages serves it from the root. Relative asset paths satisfy both.
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true, secure: false },
      '/ws': { target, ws: true, secure: false },
    },
  },
})

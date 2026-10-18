import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  build: {
    // The update and install scripts build into dist.new and swap it in afterwards, so the running app never
    // serves a half-written dist/.
    outDir: process.env.EXCEL_AUTOGRADER_CLIENT_OUT_DIR || 'dist',
    rollupOptions: {
      output: {
        // Library code in two long-lived chunks (each under Vite's 500 kB warning). Mantine depends on the vendor
        // chunk but not the other way round, so there is no circular chunk import.
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined;
          return id.includes('/node_modules/@mantine/') ? 'mantine' : 'vendor';
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3001',
    },
  },
});

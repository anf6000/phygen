import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The interface talks to the controller on port 8787. The live artwork runs on
// the separate artwork origin and is embedded through the controller.
const target = process.env.PHYGEN_API ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: false },
      '/live': { target, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});

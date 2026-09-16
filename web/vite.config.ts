import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The interface talks to the controller on port 8787. The live artwork runs on
// the separate artwork origin and is embedded through the controller.
const target = process.env.PHYGEN_API ?? 'http://127.0.0.1:8787';

export default defineConfig({
  define: {
    // Shown in the interface strip: proves which build a tab is running.
    __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
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

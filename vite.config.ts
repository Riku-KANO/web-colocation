/// <reference types="vitest/config" />
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';
import { colocationServerPlugin } from './server/vitePlugin.ts';

// HTTPS=1 serves over HTTPS with a self-signed cert (WebXR from a headset on the LAN requires it).
const https = !!process.env.HTTPS;

export default defineConfig({
  plugins: [colocationServerPlugin(), ...(https ? [basicSsl()] : [])],
  server: {
    host: true, // expose on the LAN so headsets can open it
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1000, // three.js alone is ~700 kB
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});

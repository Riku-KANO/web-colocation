/// <reference types="vitest/config" />
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';
import { colocationServerPlugin } from './server/vitePlugin.ts';

// HTTPS=1 のとき自己署名証明書で HTTPS 化する (LAN 内のヘッドセットから WebXR を使うのに必要)。
const https = !!process.env.HTTPS;

export default defineConfig({
  plugins: [colocationServerPlugin(), ...(https ? [basicSsl()] : [])],
  server: {
    host: true, // LAN に公開 (ヘッドセットから開くため)
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1000, // three.js 本体で ~700kB
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});

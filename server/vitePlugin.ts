// `npm run dev` / `vite preview` の HTTP(S) サーバーに同期サーバーを同居させる。
// 1 つのオリジンで済むので、ヘッドセットから HTTPS で開いたときも wss がそのまま通る。

import type { Plugin } from 'vite';
import { attachColocationServer } from './colocationServer.ts';

export function colocationServerPlugin(): Plugin {
  return {
    name: 'colocation-server',
    configureServer(server) {
      if (!server.httpServer) return;
      const colo = attachColocationServer(server.httpServer, {
        log: (m) => server.config.logger.info(m, { timestamp: true }),
      });
      server.httpServer.on('close', () => colo.close());
    },
    configurePreviewServer(server) {
      const colo = attachColocationServer(server.httpServer, {
        log: (m) => server.config.logger.info(m, { timestamp: true }),
      });
      server.httpServer.on('close', () => colo.close());
    },
  };
}

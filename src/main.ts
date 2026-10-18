import { App } from './app.ts';
import { showLobby } from './ui/hud.ts';
import { installEmulatorIfRequested } from './xr/session.ts';
import './style.css';

async function main() {
  // エミュレータは navigator.xr を差し替えるので、XR 対応判定より前に入れる
  await installEmulatorIfRequested();
  const opts = await showLobby();
  const app = new App(opts);
  (window as unknown as { __colo: App }).__colo = app;
  await app.start();
}

void main();

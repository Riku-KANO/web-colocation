import { PROTOCOL_VERSION } from '../shared/protocol.ts';
import type { ClientConfig } from '../shared/clientConfig.ts';
import { App } from './app.ts';
import { detectLanguage, setLanguage } from './i18n/index.ts';
import { showLobby } from './ui/lobby.ts';
import { installEmulatorIfRequested } from './xr/session.ts';
import './style.css';

/** Settings used when /api/config is unreachable (e.g. the page is served by a static host). */
const FALLBACK_CONFIG: ClientConfig = {
  protocol: PROTOCOL_VERSION,
  branding: { productName: 'WebXR Colocation', logo: null, accentColor: '#2f80ed', lobbyMessage: null },
  defaultLanguage: 'en',
  auth: { mode: 'none', identity: null, allowDisplayNameOverride: true },
  rooms: [],
  templates: [],
  allowAdhoc: true,
  voiceEnabled: true,
  xr: { inputProfilesPath: null },
  models: { allowedOrigins: [], maxBytes: 25 * 1024 * 1024 },
  allowServerOverride: false,
};

async function fetchClientConfig(): Promise<ClientConfig> {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (res.ok) return (await res.json()) as ClientConfig;
  } catch {
    // fall through
  }
  return FALLBACK_CONFIG;
}

async function main() {
  // The emulator replaces navigator.xr, so install it before checking XR support.
  await installEmulatorIfRequested();
  const client = await fetchClientConfig();
  setLanguage(detectLanguage(client.defaultLanguage));
  const opts = await showLobby(client);
  const app = new App(opts, client);
  (window as unknown as { __colo: App }).__colo = app;
  await app.start();
}

void main();

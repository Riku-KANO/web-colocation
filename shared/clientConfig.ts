// Response of GET /api/config: deployment settings the browser needs before joining a room.
// Never contains secrets (TURN credentials are sent over the WebSocket after joining).

import type { Localized } from './roomConfig.ts';

export interface ClientIdentity {
  name: string;
  email: string | null;
}

export interface LobbyRoom {
  id: string;
  title: Localized;
  template: string;
  passcode: boolean;
}

export interface ClientConfig {
  protocol: number;
  branding: {
    productName: Localized;
    logo: string | null;
    accentColor: string;
    lobbyMessage: Localized | null;
  };
  defaultLanguage: 'en' | 'ja';
  auth: {
    mode: 'none' | 'trusted-headers';
    /** The signed-in user (trusted-headers mode). */
    identity: ClientIdentity | null;
    allowDisplayNameOverride: boolean;
  };
  rooms: LobbyRoom[];
  templates: Array<{ id: string; title: Localized }>;
  allowAdhoc: boolean;
  voiceEnabled: boolean;
  /** "none" = offline: simple built-in controller/hand shapes. */
  xr: { inputProfilesPath: string | null };
  /** Limits for custom glTF models (also enforced by the browser while loading). */
  models: { allowedOrigins: string[]; maxBytes: number };
  allowServerOverride: boolean;
}

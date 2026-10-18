// ICE servers for voice, including short-lived TURN credentials (the "TURN REST API" scheme
// understood by coturn `use-auth-secret` and STUNner `ephemeral` auth):
//   username   = "<unix expiry>:<user id>"
//   credential = base64(HMAC-SHA1(shared secret, username))

import { createHmac } from 'node:crypto';
import type { IceServer } from '../shared/protocol.ts';
import type { AppConfig } from './config/schema.ts';

export interface IceConfig {
  iceServers: IceServer[];
  /** Seconds until the credentials expire (0 = static servers only). */
  ttl: number;
}

export function turnCredential(secret: string, userId: string, ttlSeconds: number, nowMs = Date.now()) {
  const expiry = Math.floor(nowMs / 1000) + ttlSeconds;
  const username = `${expiry}:${userId}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

export function iceConfigFor(voice: AppConfig['voice'], userId: string, env: NodeJS.ProcessEnv, nowMs = Date.now()): IceConfig {
  const iceServers: IceServer[] = voice.iceServers.map((s) => ({ ...s }));
  const turn = voice.turn;
  if (!turn) return { iceServers, ttl: 0 };
  const secret = env[turn.secretEnv];
  if (!secret) return { iceServers, ttl: 0 };
  const { username, credential } = turnCredential(secret, userId, turn.ttlSeconds, nowMs);
  iceServers.push({ urls: turn.urls, username, credential });
  return { iceServers, ttl: turn.ttlSeconds };
}

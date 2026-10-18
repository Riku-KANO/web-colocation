// Persistence of room state and host-edited settings. `memory` keeps nothing across restarts;
// `file` (server/fileStore.ts) writes one JSON document per room to a volume.

import type { ObjectState, Stroke } from '../shared/protocol.ts';
import type { RoomSettingsPatch } from '../shared/roomConfig.ts';

/** Settings a host changed in the app (layered on top of the config file). */
export interface HostSettings {
  title?: string;
  template?: string;
  rules?: NonNullable<RoomSettingsPatch['rules']>;
  passcodeHash?: string;
}

export interface StoredRoom {
  schemaVersion: 1;
  roomId: string;
  /** Rooms created on demand are deleted after a period of inactivity. */
  adhoc: boolean;
  updatedAt: number;
  settings: HostSettings;
  state: { objects: ObjectState[]; strokes: Stroke[] };
}

export interface Store {
  readonly kind: string;
  load(roomId: string): Promise<StoredRoom | null>;
  save(room: StoredRoom): Promise<void>;
  delete(roomId: string): Promise<void>;
  list(): Promise<Array<Pick<StoredRoom, 'roomId' | 'adhoc' | 'updatedAt'>>>;
}

export class MemoryStore implements Store {
  readonly kind = 'memory';
  private readonly rooms = new Map<string, StoredRoom>();

  async load(roomId: string): Promise<StoredRoom | null> {
    const r = this.rooms.get(roomId);
    return r ? structuredClone(r) : null;
  }

  async save(room: StoredRoom): Promise<void> {
    this.rooms.set(room.roomId, structuredClone(room));
  }

  async delete(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
  }

  async list() {
    return [...this.rooms.values()].map(({ roomId, adhoc, updatedAt }) => ({ roomId, adhoc, updatedAt }));
  }
}

// File-backed store: one JSON document per room under <dir>/rooms/. File names are hashes of the
// room id (room ids are user input). Writes go to a temp file and are renamed into place, so a
// crash never leaves a half-written document.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store, StoredRoom } from './store.ts';

const fileName = (roomId: string) => `${createHash('sha256').update(roomId).digest('hex').slice(0, 40)}.json`;

function isStoredRoom(v: unknown): v is StoredRoom {
  const r = v as StoredRoom;
  return (
    !!r &&
    r.schemaVersion === 1 &&
    typeof r.roomId === 'string' &&
    typeof r.updatedAt === 'number' &&
    typeof r.settings === 'object' &&
    Array.isArray(r.state?.objects) &&
    Array.isArray(r.state?.strokes)
  );
}

export class FileStore implements Store {
  readonly kind = 'file';
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = join(dir, 'rooms');
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // Fail fast on read-only volumes instead of losing data later.
    const probe = join(this.dir, `.probe-${process.pid}`);
    await writeFile(probe, 'ok');
    await unlink(probe);
  }

  async load(roomId: string): Promise<StoredRoom | null> {
    let text: string;
    try {
      text = await readFile(join(this.dir, fileName(roomId)), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    const data = JSON.parse(text) as unknown;
    if (!isStoredRoom(data) || data.roomId !== roomId) return null;
    return data;
  }

  async save(room: StoredRoom): Promise<void> {
    const file = join(this.dir, fileName(room.roomId));
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(room));
    await rename(tmp, file);
  }

  async delete(roomId: string): Promise<void> {
    try {
      await unlink(join(this.dir, fileName(roomId)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }

  async list(): Promise<Array<Pick<StoredRoom, 'roomId' | 'adhoc' | 'updatedAt'>>> {
    const out: Array<Pick<StoredRoom, 'roomId' | 'adhoc' | 'updatedAt'>> = [];
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const data = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as unknown;
        if (isStoredRoom(data)) out.push({ roomId: data.roomId, adhoc: data.adhoc, updatedAt: data.updatedAt });
      } catch {
        // ignore unreadable documents
      }
    }
    return out;
  }
}

export async function createFileStore(dir: string): Promise<FileStore> {
  const store = new FileStore(dir);
  await store.init();
  return store;
}

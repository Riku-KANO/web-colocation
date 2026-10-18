// Room passcodes are stored only as scrypt hashes: scrypt$N$r$p$<salt b64>$<hash b64>.

import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (pass: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(pass, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))));

const KEY_LEN = 32;
const MAXMEM = 64 * 1024 * 1024;

export async function hashPasscode(passcode: string, params = { N: 16384, r: 8, p: 1 }): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(passcode.normalize('NFKC'), salt, KEY_LEN, { ...params, maxmem: MAXMEM });
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPasscode(passcode: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (!Number.isInteger(N) || N < 2 || N > 1 << 20 || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) {
    return false;
  }
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (expected.length < 16) return false;
  const key = await scrypt(passcode.normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: MAXMEM });
  return timingSafeEqual(key, expected);
}

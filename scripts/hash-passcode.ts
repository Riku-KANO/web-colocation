// Prints a scrypt hash for a room passcode, to paste into `rooms.list[].passcodeHash`.
//
//   npm run hash-passcode -- 'my passcode'
//   echo -n 'my passcode' | npm run hash-passcode      (keeps it out of shell history)

import { hashPasscode } from '../server/passcode.ts';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

const passcode = process.argv[2] ?? (process.stdin.isTTY ? '' : await readStdin());
if (!passcode) {
  console.error('usage: npm run hash-passcode -- <passcode>   (or pipe it on stdin)');
  process.exit(1);
}
console.log(await hashPasscode(passcode));

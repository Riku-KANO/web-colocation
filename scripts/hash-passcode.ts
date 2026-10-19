// Prints a scrypt hash for a room passcode, to paste into `rooms.list[].passcodeHash`.
//
//   npm run hash-passcode                        (asks for it without echoing; recommended)
//   npm run hash-passcode -- 'my passcode'       (ends up in your shell history)
//   some-secret-tool | npm run hash-passcode     (reads stdin when it is not a terminal)

import { hashPasscode } from '../server/passcode.ts';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

/** Reads a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  const { stdin, stderr } = process;
  stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  let value = '';
  return new Promise((resolve) => {
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
      resolve(value);
    };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          stderr.write('\n');
          process.exit(130);
        }
        value = ch === '\u007f' || ch === '\b' ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on('data', onData);
  });
}

let passcode = process.argv[2];
if (passcode === undefined && process.stdin.isTTY) {
  passcode = await promptHidden('Passcode: ');
  if (passcode && (await promptHidden('Again: ')) !== passcode) {
    console.error('The passcodes do not match.');
    process.exit(1);
  }
} else if (passcode === undefined) {
  passcode = await readStdin();
}
if (!passcode) {
  console.error('usage: npm run hash-passcode   (prompts), or npm run hash-passcode -- <passcode>');
  process.exit(1);
}
console.log(await hashPasscode(passcode));

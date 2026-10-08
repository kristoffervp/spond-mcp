import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { login } from './auth.js';
import { PublicError } from './errors.js';

process.umask(0o077);

// The password is read with echo turned off and is never saved; only Spond's tokens are.
async function askCredentials() {
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) {
    if (!muted) process.stdout.write(chunk, encoding);
    callback();
  } });
  const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  rl.on('SIGINT', () => {
    rl.close();
    process.stdout.write('\n');
    process.exit(130);
  });
  try {
    const identifier = await rl.question('Spond email or phone number: ');
    const password = rl.question('Password (hidden): ');
    muted = true;
    const value = await password;
    muted = false;
    process.stdout.write('\n');
    return { identifier, password: value };
  } finally {
    rl.close();
  }
}

try {
  await login(await askCredentials());
  console.log('Spond sign-in saved in the private .data/ folder. It renews automatically while Spond allows it.');
} catch (error) {
  console.error(error instanceof PublicError ? error.message : 'Spond sign-in failed.');
  process.exitCode = 1;
}

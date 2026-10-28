#!/usr/bin/env node
// Terminal alternative to the web setup page: `npm run setup`.

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { loadConfig } from './config.js';
import { Keeper } from './keeper.js';

// One readline for the whole session so piped input isn't lost between questions.
let muted = false;
const output = new Writable({
  write(chunk, enc, cb) {
    if (!muted) process.stdout.write(chunk, enc);
    cb();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
const lines = rl[Symbol.asyncIterator]();

async function ask(question, { hidden = false } = {}) {
  process.stdout.write(question);
  muted = hidden;
  const { value = '', done } = await lines.next();
  muted = false;
  if (hidden) process.stdout.write('\n');
  if (done) {
    console.error('Input ended early.');
    process.exit(1);
  }
  return value;
}

const config = loadConfig();
const keeper = await new Keeper({ config }).load();
if (keeper.state !== 'uninitialized') {
  console.error(`A vault already exists at ${config.vaultPath}. Delete it first if you want to start over.`);
  process.exit(1);
}

console.log('Your seed will be encrypted with a passphrase and stored at', config.vaultPath);
const mnemonic = await ask('Seed phrase (input hidden): ', { hidden: true });
const passphrase = await ask('Encryption passphrase, min 12 chars (hidden): ', { hidden: true });
const confirm = await ask('Confirm passphrase (hidden): ', { hidden: true });
if (passphrase !== confirm) {
  console.error('Passphrases do not match.');
  process.exit(1);
}
const bip39Passphrase = await ask('BIP-39 passphrase / "25th word" (blank if none, hidden): ', { hidden: true });

try {
  const { apiKey, firstAddress } = await keeper.setup({ mnemonic, passphrase, bip39Passphrase });
  keeper.lock();
  console.log('\nWallet saved.');
  console.log(`Account 0 address: ${firstAddress}  (check it matches your wallet)`);
  console.log(`\nAPI key (shown once, store it somewhere safe):\n\n  ${apiKey}\n`);
  console.log('Start the server with: npm start');
} catch (err) {
  console.error(`Setup failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
}

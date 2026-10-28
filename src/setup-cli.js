#!/usr/bin/env node
// Terminal alternative to the web setup page: `npm run setup`.

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { loadConfig } from './config.js';
import { Keeper } from './keeper.js';
import { catalog } from './wallet.js';

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

const coins = catalog(config.chains);
console.log('\nSupported coins:');
coins.forEach((c, n) => {
  const extras = [c.tokens.length && `tokens: ${c.tokens.join(', ')}`, c.testnet && 'testnet'].filter(Boolean).join('; ');
  console.log(`  ${String(n + 1).padStart(2)}. ${c.id.padEnd(16)} ${c.name} (${c.symbol})${extras ? `  [${extras}]` : ''}`);
});
const picked = (await ask('\nWhich do you want? Names or numbers, comma-separated (e.g. btc, eth, sol): '))
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean)
  .map((x) => (/^\d+$/.test(x) ? coins[Number(x) - 1]?.id ?? x : x));

try {
  const { apiKey, addresses } = await keeper.setup({ mnemonic, passphrase, bip39Passphrase, chains: picked });
  keeper.lock();
  console.log('\nWallet saved. Account 0 addresses (check they match your wallet):');
  for (const [id, address] of Object.entries(addresses)) console.log(`  ${id.padEnd(16)} ${address}`);
  console.log(`\nAPI key (shown once, store it somewhere safe):\n\n  ${apiKey}\n`);
  console.log('Start the server with: npm start');
} catch (err) {
  console.error(`Setup failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
}

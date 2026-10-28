#!/usr/bin/env node
// Entry point: loads config + vault, optionally auto-unlocks, and starts the API.

import { loadConfig } from './config.js';
import { Keeper } from './keeper.js';
import { createApp } from './app.js';

const config = loadConfig();
const keeper = await new Keeper({ config }).load();

// Unattended start: unlock from SEEDTOAPI_PASSPHRASE, then scrub it from the environment.
if (process.env.SEEDTOAPI_PASSPHRASE && keeper.state === 'locked') {
  try {
    await keeper.unlock(process.env.SEEDTOAPI_PASSPHRASE);
    console.log('Wallet unlocked from SEEDTOAPI_PASSPHRASE.');
  } catch (err) {
    console.error(`Could not unlock from SEEDTOAPI_PASSPHRASE: ${err.message}`);
    process.exit(1);
  } finally {
    delete process.env.SEEDTOAPI_PASSPHRASE;
  }
}

const app = createApp(keeper);
const server = app.listen(config.port, config.host, () => {
  const url = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}`;
  console.log(`SeedToAPI listening on ${url}  (wallet: ${keeper.state})`);
  if (keeper.state === 'uninitialized') console.log(`Open ${url} in a browser on this machine, or run "npm run setup", to enter your seed.`);
  if (keeper.state === 'locked') console.log(`Wallet is locked. Unlock at ${url} or POST /unlock {"passphrase": "..."}.`);
  if (!['127.0.0.1', '::1', 'localhost'].includes(config.host)) {
    console.warn('WARNING: listening on a non-loopback address. Put this behind HTTPS and a firewall; the API key is all that protects your funds.');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    keeper.lock();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

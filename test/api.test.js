// End-to-end tests against a local Ganache chain.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ganache from 'ganache';
import { verifyMessage, JsonRpcProvider, parseEther, Wallet } from 'ethers';
import { DEFAULT_CONFIG } from '../src/config.js';
import { Keeper } from '../src/keeper.js';
import { createApp } from '../src/app.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
const ACCOUNT0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const RECIPIENT = Wallet.createRandom().address;
const PASSPHRASE = 'a very long passphrase';
const kdf = { name: 'scrypt', N: 2 ** 10, r: 8, p: 1, keyLen: 32 };

let chain, server, base, dir, apiKey, config;

async function api(method, path, body, key = apiKey) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

function startApp(keeper) {
  return new Promise((resolve) => {
    const s = createApp(keeper, { log: {} }).listen(0, '127.0.0.1', () => resolve(s));
  });
}

before(async () => {
  chain = ganache.server({ logging: { quiet: true }, chain: { chainId: 1337 }, wallet: { mnemonic: MNEMONIC } });
  await chain.listen(0);
  dir = await mkdtemp(join(tmpdir(), 'seedtoapi-'));
  config = {
    ...DEFAULT_CONFIG,
    vaultPath: join(dir, 'vault.json'),
    defaultChain: 'local',
    chains: { local: { chainId: 1337, rpcUrl: `http://127.0.0.1:${chain.address().port}`, symbol: 'ETH' } },
    policy: { ...DEFAULT_CONFIG.policy, maxNativeValuePerTx: { local: '5' } },
  };
  server = await startApp(await new Keeper({ config, kdf }).load());
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await chain?.close();
  await rm(dir, { recursive: true, force: true });
});

test('setup validates input and returns an API key once', async () => {
  assert.equal((await api('GET', '/status')).body.state, 'uninitialized');
  assert.equal((await api('POST', '/setup', { mnemonic: 'not a seed', passphrase: PASSPHRASE })).status, 400);
  assert.equal((await api('POST', '/setup', { mnemonic: MNEMONIC, passphrase: 'short' })).status, 400);

  const res = await api('POST', '/setup', { mnemonic: `  ${MNEMONIC.toUpperCase()} `, passphrase: PASSPHRASE });
  assert.equal(res.status, 200);
  assert.match(res.body.apiKey, /^sk_/);
  assert.equal(res.body.firstAddress, ACCOUNT0);
  apiKey = res.body.apiKey;

  const onDisk = await readFile(config.vaultPath, 'utf8');
  assert.ok(!onDisk.includes('junk') && !onDisk.includes(apiKey));
  assert.equal((await api('POST', '/setup', { mnemonic: MNEMONIC, passphrase: PASSPHRASE })).status, 409);
});

test('API requires a valid key', async () => {
  assert.equal((await api('GET', '/v1/accounts', undefined, null)).status, 401);
  assert.equal((await api('GET', '/v1/accounts', undefined, 'sk_wrong')).status, 401);
  const res = await fetch(`${base}/v1/chains`, { headers: { 'x-api-key': apiKey } });
  assert.equal(res.status, 200);
});

test('lists derived accounts', async () => {
  const res = await api('GET', '/v1/accounts?count=3');
  assert.equal(res.body.accounts.length, 3);
  assert.equal(res.body.accounts[0].address, ACCOUNT0);
  assert.equal(res.body.accounts[1].path, "m/44'/60'/0'/0/1");
});

test('reads native balance', async () => {
  const res = await api('GET', '/v1/balance?account=0');
  assert.equal(res.status, 200);
  assert.equal(res.body.asset, 'ETH');
  assert.equal(res.body.balance, '1000.0');
});

test('dry run estimates without sending', async () => {
  const res = await api('POST', '/v1/transfer', { to: RECIPIENT, amount: '1.5', dryRun: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.gasLimit, '21000');
  const provider = new JsonRpcProvider(config.chains.local.rpcUrl);
  assert.equal(await provider.getBalance(RECIPIENT), 0n);
});

test('sends native coin and reports status', async () => {
  const res = await api('POST', '/v1/transfer', { to: RECIPIENT, amount: '1.5', account: 0, wait: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'success');
  const provider = new JsonRpcProvider(config.chains.local.rpcUrl);
  assert.equal(await provider.getBalance(RECIPIENT), parseEther('1.5'));

  const status = await api('GET', `/v1/transactions/${res.body.hash}`);
  assert.equal(status.body.status, 'success');
  assert.equal(status.body.from, ACCOUNT0);
});

test('concurrent sends get distinct nonces', async () => {
  const results = await Promise.all(
    [1, 2, 3].map(() => api('POST', '/v1/transfer', { to: RECIPIENT, amount: '0.1', account: 1 })),
  );
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(new Set(results.map((r) => r.body.nonce)).size, 3);
});

test('rejects bad input and enforces policy', async () => {
  assert.equal((await api('POST', '/v1/transfer', { to: 'nope', amount: '1' })).status, 400);
  assert.equal((await api('POST', '/v1/transfer', { to: RECIPIENT, amount: '-1' })).status, 400);
  assert.equal((await api('POST', '/v1/transfer', { to: RECIPIENT, amount: '0' })).status, 400);
  assert.equal((await api('POST', '/v1/transfer', { to: RECIPIENT, amount: '6' })).status, 403);
  assert.equal((await api('POST', '/v1/transfer', { to: RECIPIENT, amount: '1', chain: 'nowhere' })).status, 400);
  assert.equal((await api('POST', '/v1/transfer', { to: RECIPIENT, amount: '1', account: 1000 })).status, 400);
  // Account 20 is unfunded, so the transfer would fail.
  assert.equal((await api('POST', '/v1/transfer', { to: RECIPIENT, amount: '1', account: 20, dryRun: true })).status, 422);
});

test('raw transaction', async () => {
  const res = await api('POST', '/v1/transactions', { to: RECIPIENT, value: '1000', data: '0x', wait: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'success');
});

test('signs messages and typed data', async () => {
  const res = await api('POST', '/v1/sign/message', { message: 'hello' });
  assert.equal(verifyMessage('hello', res.body.signature), ACCOUNT0);
  const typed = await api('POST', '/v1/sign/typed-data', {
    domain: { name: 'Test', version: '1', chainId: 1337 },
    types: { Mail: [{ name: 'contents', type: 'string' }] },
    message: { contents: 'hi' },
  });
  assert.equal(typed.status, 200, JSON.stringify(typed.body));
  assert.match(typed.body.signature, /^0x[0-9a-f]{130}$/);
});

test('lock and unlock', async () => {
  assert.equal((await api('POST', '/lock')).body.state, 'locked');
  assert.equal((await api('GET', '/v1/accounts')).status, 423);
  assert.equal((await api('POST', '/unlock', { passphrase: 'wrong passphrase' }, null)).status, 401);
  assert.equal((await api('POST', '/unlock', { passphrase: PASSPHRASE }, null)).body.state, 'unlocked');
  assert.equal((await api('GET', '/v1/accounts')).status, 200);
});

test('vault survives a restart', async () => {
  const keeper = await new Keeper({ config }).load();
  assert.equal(keeper.state, 'locked');
  assert.ok(keeper.checkApiKey(apiKey));
  await keeper.unlock(PASSPHRASE);
  assert.equal(keeper.wallet.address(0), ACCOUNT0);
  keeper.lock();
});

test('rotating the API key invalidates the old one', async () => {
  assert.equal((await api('POST', '/v1/api-key/rotate', { passphrase: 'wrong passphrase' })).status, 401);
  const res = await api('POST', '/v1/api-key/rotate', { passphrase: PASSPHRASE });
  assert.equal(res.status, 200);
  assert.equal((await api('GET', '/v1/accounts')).status, 401);
  apiKey = res.body.apiKey;
  assert.equal((await api('GET', '/v1/accounts')).status, 200);
});

test('allowedRecipients blocks other destinations', async () => {
  config.policy.allowedRecipients = [ACCOUNT0];
  try {
    assert.equal((await api('POST', '/v1/transfer', { to: RECIPIENT, amount: '0.1', dryRun: true })).status, 403);
    assert.equal((await api('POST', '/v1/transactions', { to: RECIPIENT, dryRun: true })).status, 403);
  } finally {
    config.policy.allowedRecipients = [];
  }
});

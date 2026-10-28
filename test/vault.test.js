import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealVault, openVault, hashApiKey, apiKeyMatches, generateApiKey, WrongPassphraseError } from '../src/vault.js';

const kdf = { name: 'scrypt', N: 2 ** 10, r: 8, p: 1, keyLen: 32 };
const secret = { mnemonic: 'test test test test test test test test test test test junk', bip39Passphrase: '' };

test('seal/open round-trips and never stores the seed in plaintext', async () => {
  const apiKey = generateApiKey();
  const vault = await sealVault({ secret, passphrase: 'correct horse battery', apiKeyHash: hashApiKey(apiKey), kdf });
  assert.ok(!JSON.stringify(vault).includes('junk'));
  assert.deepEqual(await openVault(vault, 'correct horse battery'), secret);
});

test('wrong passphrase is rejected', async () => {
  const vault = await sealVault({ secret, passphrase: 'correct horse battery', apiKeyHash: hashApiKey('k'), kdf });
  await assert.rejects(openVault(vault, 'wrong passphrase!!'), WrongPassphraseError);
});

test('swapping the API key hash invalidates the vault', async () => {
  const vault = await sealVault({ secret, passphrase: 'correct horse battery', apiKeyHash: hashApiKey('k'), kdf });
  vault.apiKeyHash = hashApiKey('attacker');
  await assert.rejects(openVault(vault, 'correct horse battery'), WrongPassphraseError);
});

test('API key comparison', () => {
  const key = generateApiKey();
  assert.ok(apiKeyMatches(key, hashApiKey(key)));
  assert.ok(!apiKeyMatches(key + 'x', hashApiKey(key)));
  assert.ok(!apiKeyMatches(undefined, hashApiKey(key)));
});

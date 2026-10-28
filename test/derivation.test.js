// Addresses must match what other wallets derive from the same seed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WalletService } from '../src/wallet.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { slip10Ed25519 } from '../src/chains/solana.js';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const JUNK = 'test test test test test test test test test test test junk';

function wallet(mnemonic, enabledChains) {
  return new WalletService({ mnemonic, config: DEFAULT_CONFIG, enabledChains });
}

test('Bitcoin uses BIP-84 native SegWit (official test vector)', () => {
  const w = wallet(ABANDON, ['bitcoin']);
  assert.equal(w.chain('bitcoin').address(0), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.equal(w.chain('bitcoin').path(0), "m/84'/0'/0'");
});

test('Litecoin and Bitcoin testnet use their own prefixes and coin types', () => {
  const w = wallet(ABANDON, ['litecoin', 'bitcoin-testnet']);
  assert.match(w.chain('ltc').address(0), /^ltc1q/);
  assert.match(w.chain('bitcoin-testnet').address(0), /^tb1q/);
});

test('Ethereum matches MetaMask/Hardhat default accounts', () => {
  const w = wallet(JUNK, ['ethereum', 'base']);
  assert.equal(w.chain('eth').address(0), '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  assert.equal(w.chain('base').address(1), '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
});

test('SLIP-10 ed25519 derivation (official test vector 1)', () => {
  const seed = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  const hex = (path) => Buffer.from(slip10Ed25519(seed, path)).toString('hex');
  assert.equal(hex('m'), '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7');
  assert.equal(hex("m/0'"), '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3');
  assert.equal(hex("m/0'/1'"), 'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2');
  assert.throws(() => slip10Ed25519(seed, 'm/0'), /hardened/);
});

test('Solana uses the Phantom path and different accounts differ', () => {
  const w = wallet(ABANDON, ['solana']);
  assert.equal(w.chain('sol').path(0), "m/44'/501'/0'/0'");
  // Phantom's first address for this seed.
  assert.equal(w.chain('sol').address(0), 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  assert.notEqual(w.chain('sol').address(0), w.chain('sol').address(1));
});

test('only enabled chains can be used', () => {
  const w = wallet(ABANDON, ['bitcoin']);
  assert.throws(() => w.chain('ethereum'), { status: 403 });
  assert.throws(() => w.chain('dogecoin'), { status: 400 });
  assert.equal(w.chain().id, 'bitcoin'); // the only enabled chain is the default
});

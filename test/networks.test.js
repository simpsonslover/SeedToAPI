import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { NETWORKS, ALIASES } from '../src/networks.js';

// A typo in a built-in token address would send funds to the wrong contract, so
// every EVM entry must pass its EIP-55 checksum and every Solana mint must parse.
test('built-in token addresses are well-formed', () => {
  for (const [id, net] of Object.entries(NETWORKS)) {
    for (const [symbol, address] of Object.entries(net.tokens || {})) {
      if (net.family === 'evm') assert.equal(getAddress(address), address, `${id} ${symbol}`);
      else assert.equal(new PublicKey(address).toBase58(), address, `${id} ${symbol}`);
    }
  }
});

test('aliases point at real networks', () => {
  for (const [alias, id] of Object.entries(ALIASES)) assert.ok(NETWORKS[id], alias);
});

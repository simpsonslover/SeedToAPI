// Loads config.json (optional) and applies environment overrides.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NETWORKS, FAMILIES } from './networks.js';

export const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 8787,
  vaultPath: './data/vault.json',
  // Used when a request leaves out "chain". If unset, requests must name a
  // chain unless only one is enabled.
  defaultChain: null,
  chains: NETWORKS,
  policy: {
    // If non-empty, transfers may only go to these addresses (any chain family).
    allowedRecipients: [],
    // Allow POST /v1/transactions (arbitrary contract calls / pre-built transactions).
    allowRawTransactions: true,
    // Optional per-chain cap on the native coin per transaction, e.g. { "bitcoin": "0.01", "ethereum": "0.5" }.
    maxNativeValuePerTx: {},
    // Highest account index the API will use.
    maxAccountIndex: 99,
  },
};

// Merge config.json "chains" over the built-in networks: override a field of a
// known network (e.g. its rpcUrl) or add your own EVM chain.
export function mergeChains(overrides = {}) {
  const chains = { ...NETWORKS };
  for (const [id, entry] of Object.entries(overrides)) {
    const merged = { ...(NETWORKS[id] || { family: 'evm', decimals: 18, name: id }), ...entry };
    if (NETWORKS[id]?.tokens || entry.tokens) merged.tokens = { ...(NETWORKS[id]?.tokens || {}), ...(entry.tokens || {}) };
    if (!FAMILIES.includes(merged.family)) throw new Error(`chains.${id}.family must be one of ${FAMILIES.join(', ')}`);
    if (merged.family === 'evm' && (!merged.rpcUrl || !Number.isInteger(merged.chainId))) {
      throw new Error(`chains.${id} needs an rpcUrl and an integer chainId`);
    }
    merged.symbol ??= 'ETH';
    chains[id] = merged;
  }
  return chains;
}

export function loadConfig({ path = process.env.SEEDTOAPI_CONFIG || './config.json', env = process.env } = {}) {
  let fileConfig = {};
  const configPath = resolve(path);
  if (existsSync(configPath)) {
    fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  }
  const config = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    chains: mergeChains(fileConfig.chains),
    policy: { ...DEFAULT_CONFIG.policy, ...(fileConfig.policy || {}) },
  };
  if (env.SEEDTOAPI_HOST) config.host = env.SEEDTOAPI_HOST;
  if (env.SEEDTOAPI_PORT) config.port = Number(env.SEEDTOAPI_PORT);
  if (env.SEEDTOAPI_VAULT) config.vaultPath = env.SEEDTOAPI_VAULT;
  if (env.SEEDTOAPI_DEFAULT_CHAIN) config.defaultChain = env.SEEDTOAPI_DEFAULT_CHAIN;
  config.vaultPath = resolve(config.vaultPath);
  return config;
}

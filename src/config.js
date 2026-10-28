// Loads config.json (optional) and applies environment overrides.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_CHAINS = {
  ethereum: { chainId: 1, rpcUrl: 'https://ethereum-rpc.publicnode.com', symbol: 'ETH' },
  base: { chainId: 8453, rpcUrl: 'https://mainnet.base.org', symbol: 'ETH' },
  arbitrum: { chainId: 42161, rpcUrl: 'https://arb1.arbitrum.io/rpc', symbol: 'ETH' },
  optimism: { chainId: 10, rpcUrl: 'https://mainnet.optimism.io', symbol: 'ETH' },
  polygon: { chainId: 137, rpcUrl: 'https://polygon-bor-rpc.publicnode.com', symbol: 'POL' },
  bsc: { chainId: 56, rpcUrl: 'https://bsc-rpc.publicnode.com', symbol: 'BNB' },
  sepolia: { chainId: 11155111, rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', symbol: 'ETH' },
  'base-sepolia': { chainId: 84532, rpcUrl: 'https://sepolia.base.org', symbol: 'ETH' },
};

export const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 8787,
  vaultPath: './data/vault.json',
  defaultChain: 'sepolia',
  // Standard Ethereum path (MetaMask, Ledger Live, etc). {index} is the account number.
  derivationPath: "m/44'/60'/0'/0/{index}",
  chains: DEFAULT_CHAINS,
  policy: {
    // If non-empty, transfers may only go to these addresses.
    allowedRecipients: [],
    // Allow POST /v1/transactions (arbitrary contract calls).
    allowRawTransactions: true,
    // Optional per-chain cap on native value per transaction, e.g. { "ethereum": "0.5" }.
    maxNativeValuePerTx: {},
    // Highest account index the API will use.
    maxAccountIndex: 99,
  },
};

export function loadConfig({ path = process.env.SEEDTOAPI_CONFIG || './config.json', env = process.env } = {}) {
  let fileConfig = {};
  const configPath = resolve(path);
  if (existsSync(configPath)) {
    fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  }
  const config = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    // A config file's chains are merged over the defaults, so you can override one RPC URL.
    chains: { ...DEFAULT_CHAINS, ...(fileConfig.chains || {}) },
    policy: { ...DEFAULT_CONFIG.policy, ...(fileConfig.policy || {}) },
  };
  if (env.SEEDTOAPI_HOST) config.host = env.SEEDTOAPI_HOST;
  if (env.SEEDTOAPI_PORT) config.port = Number(env.SEEDTOAPI_PORT);
  if (env.SEEDTOAPI_VAULT) config.vaultPath = env.SEEDTOAPI_VAULT;
  if (env.SEEDTOAPI_DEFAULT_CHAIN) config.defaultChain = env.SEEDTOAPI_DEFAULT_CHAIN;
  config.vaultPath = resolve(config.vaultPath);
  return config;
}

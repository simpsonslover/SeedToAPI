// Routes each request to the right chain family for the network it names,
// and only allows the networks the owner enabled.

import { Mnemonic, getBytes } from 'ethers';
import { ApiError } from './chains/common.js';
import { EvmChain } from './chains/evm.js';
import { BitcoinChain } from './chains/bitcoin.js';
import { SolanaChain } from './chains/solana.js';
import { ALIASES } from './networks.js';

export { ApiError };

const FAMILY_CLASSES = { evm: EvmChain, bitcoin: BitcoinChain, solana: SolanaChain };

export function normalizeMnemonic(phrase) {
  return String(phrase).trim().toLowerCase().split(/\s+/).join(' ');
}

export function isValidMnemonic(phrase) {
  return Mnemonic.isValidMnemonic(normalizeMnemonic(phrase));
}

// Turn ids/aliases from user input into known network ids, or throw.
export function resolveChainIds(list, chains) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new ApiError(400, 'Pick at least one chain', { available: Object.keys(chains) });
  }
  const ids = new Set();
  for (const item of list) {
    const id = resolveChainId(item, chains);
    if (!id) throw new ApiError(400, `Unknown chain "${item}"`, { available: Object.keys(chains) });
    ids.add(id);
  }
  return [...ids].sort();
}

export function resolveChainId(name, chains) {
  if (typeof name !== 'string') return null;
  const key = name.trim().toLowerCase();
  if (chains[key]) return key;
  if (ALIASES[key] && chains[ALIASES[key]]) return ALIASES[key];
  return null;
}

// Public description of the supported networks (no wallet data).
export function catalog(chains) {
  const aliases = Object.entries(ALIASES);
  return Object.entries(chains).map(([id, net]) => ({
    id,
    name: net.name,
    symbol: net.symbol,
    family: net.family,
    testnet: Boolean(net.testnet),
    aliases: aliases.filter(([, target]) => target === id).map(([alias]) => alias),
    tokens: Object.keys(net.tokens || {}),
    nfts: net.family !== 'bitcoin',
  }));
}

export class WalletService {
  #seed;
  #chains = new Map();

  constructor({ mnemonic, bip39Passphrase = '', config, enabledChains }) {
    const phrase = normalizeMnemonic(mnemonic);
    if (!Mnemonic.isValidMnemonic(phrase)) throw new Error('Invalid mnemonic');
    this.#seed = getBytes(Mnemonic.fromPhrase(phrase, bip39Passphrase).computeSeed());
    this.config = config;
    this.enabled = enabledChains;
  }

  setEnabledChains(ids) {
    this.enabled = ids;
  }

  // --- dispatch ------------------------------------------------------------

  chainId(name) {
    if (name === undefined || name === null || name === '') {
      if (this.config.defaultChain) return this.chainId(this.config.defaultChain);
      if (this.enabled.length === 1) return this.enabled[0];
      throw new ApiError(400, 'chain is required', { enabled: this.enabled });
    }
    const id = resolveChainId(name, this.config.chains);
    if (!id) throw new ApiError(400, `Unknown chain "${name}"`, { enabled: this.enabled });
    if (!this.enabled.includes(id)) {
      throw new ApiError(403, `Chain "${id}" is not enabled for this wallet`, { enabled: this.enabled });
    }
    return id;
  }

  chain(name) {
    const id = this.chainId(name);
    if (!this.#chains.has(id)) {
      const net = this.config.chains[id];
      const Family = FAMILY_CLASSES[net.family];
      this.#chains.set(id, new Family({ id, net, seed: this.#seed, policy: this.config.policy }));
    }
    return this.#chains.get(id);
  }

  accountIndex(value) {
    const index = value === undefined || value === null || value === '' ? 0 : Number(value);
    if (!Number.isInteger(index) || index < 0 || index > this.config.policy.maxAccountIndex) {
      throw new ApiError(400, `account must be an integer between 0 and ${this.config.policy.maxAccountIndex}`);
    }
    return index;
  }

  #call(method, params = {}) {
    const chain = this.chain(params.chain ?? params.coin);
    if (typeof chain[method] !== 'function') {
      throw new ApiError(400, `${method} is not supported on ${chain.net.name}`);
    }
    return chain[method]({ ...params, account: this.accountIndex(params.account), dryRun: Boolean(params.dryRun), wait: Boolean(params.wait) });
  }

  // --- public operations ---------------------------------------------------

  listChains() {
    return this.enabled.map((id) => {
      const net = this.config.chains[id];
      return {
        id,
        name: net.name,
        symbol: net.symbol,
        family: net.family,
        testnet: Boolean(net.testnet),
        tokens: Object.keys(net.tokens || {}),
        default: id === this.config.defaultChain,
      };
    });
  }

  // Account N's address on every enabled chain.
  addresses({ account } = {}) {
    const index = this.accountIndex(account);
    return {
      account: index,
      addresses: Object.fromEntries(this.enabled.map((id) => [id, this.chain(id).address(index)])),
    };
  }

  listAccounts({ chain, offset = 0, count = 5 } = {}) {
    const c = this.chain(chain);
    offset = this.accountIndex(offset);
    count = Math.min(Math.max(Number(count) || 1, 1), 50);
    const last = Math.min(offset + count - 1, this.config.policy.maxAccountIndex);
    const accounts = [];
    for (let i = offset; i <= last; i++) accounts.push({ account: i, address: c.address(i), path: c.path(i) });
    return { chain: c.id, accounts };
  }

  async balance(params) {
    return this.#call('balance', params);
  }

  async transfer(params) {
    return this.#call('transfer', params);
  }

  async transferNft(params) {
    return this.#call('transferNft', params);
  }

  async sendTransaction(params) {
    if (!this.config.policy.allowRawTransactions) {
      throw new ApiError(403, 'Raw transactions are disabled by policy.allowRawTransactions');
    }
    return this.#call('sendTransaction', params);
  }

  async signMessage(params) {
    return this.#call('signMessage', params);
  }

  async signTypedData(params) {
    return this.#call('signTypedData', params);
  }

  async transactionStatus(params) {
    return this.#call('transactionStatus', params);
  }

  // Drop references to key material. (JS cannot guarantee memory is zeroed.)
  destroy() {
    for (const c of this.#chains.values()) c.destroy();
    this.#chains.clear();
    this.#seed?.fill(0);
    this.#seed = null;
  }
}

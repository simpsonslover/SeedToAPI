// Wallet operations on EVM chains, backed by an HD wallet derived from the seed.

import {
  HDNodeWallet,
  JsonRpcProvider,
  Contract,
  Interface,
  Mnemonic,
  getAddress,
  isAddress,
  isHexString,
  parseUnits,
  formatUnits,
  formatEther,
} from 'ethers';

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// How long to trust our own record of the next nonce over the node's (in case a tx is dropped).
const NONCE_MEMORY_MS = 60_000;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
];
const ERC721_IFACE = new Interface(['function safeTransferFrom(address from, address to, uint256 tokenId)']);
const ERC1155_IFACE = new Interface([
  'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
]);
const ERC20_IFACE = new Interface(ERC20_ABI);

const RPC_FAILURE_CODES = new Set([
  'NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT', 'BAD_DATA', 'UNKNOWN_ERROR',
  'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT',
]);

// True when the error means the RPC node could not be reached or misbehaved,
// as opposed to the node rejecting the transaction.
export function isRpcFailure(err) {
  return RPC_FAILURE_CODES.has(err?.code) || RPC_FAILURE_CODES.has(err?.cause?.code) || err?.name === 'FetchError';
}

export function isValidMnemonic(phrase) {
  return Mnemonic.isValidMnemonic(normalizeMnemonic(phrase));
}

export function normalizeMnemonic(phrase) {
  return String(phrase).trim().toLowerCase().split(/\s+/).join(' ');
}

export class WalletService {
  #mnemonic;
  #nodes = new Map();
  #providers = new Map();
  #sendLocks = new Map();
  #nextNonce = new Map();

  constructor({ mnemonic, bip39Passphrase = '', config, providerFactory }) {
    const phrase = normalizeMnemonic(mnemonic);
    if (!Mnemonic.isValidMnemonic(phrase)) throw new Error('Invalid mnemonic');
    this.#mnemonic = Mnemonic.fromPhrase(phrase, bip39Passphrase);
    this.config = config;
    this.providerFactory =
      providerFactory ||
      ((chain) => new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true, cacheTimeout: -1 }));
  }

  // --- helpers -----------------------------------------------------------

  chain(name) {
    const key = name || this.config.defaultChain;
    const chain = this.config.chains[key];
    if (!chain) throw new ApiError(400, `Unknown chain "${key}"`, { available: Object.keys(this.config.chains) });
    return { name: key, ...chain };
  }

  provider(chainName) {
    const chain = this.chain(chainName);
    if (!this.#providers.has(chain.name)) this.#providers.set(chain.name, this.providerFactory(chain));
    return this.#providers.get(chain.name);
  }

  accountIndex(value) {
    const index = value === undefined || value === null || value === '' ? 0 : Number(value);
    if (!Number.isInteger(index) || index < 0 || index > this.config.policy.maxAccountIndex) {
      throw new ApiError(400, `account must be an integer between 0 and ${this.config.policy.maxAccountIndex}`);
    }
    return index;
  }

  node(index) {
    if (!this.#nodes.has(index)) {
      const path = this.config.derivationPath.replace('{index}', String(index));
      this.#nodes.set(index, HDNodeWallet.fromMnemonic(this.#mnemonic, path));
    }
    return this.#nodes.get(index);
  }

  signer(chainName, account) {
    return this.node(this.accountIndex(account)).connect(this.provider(chainName));
  }

  address(account) {
    return this.node(this.accountIndex(account)).address;
  }

  checkRecipient(address, field = 'to') {
    if (typeof address !== 'string' || !isAddress(address)) throw new ApiError(400, `${field} must be a valid 0x address`);
    const normalized = getAddress(address);
    const allow = this.config.policy.allowedRecipients || [];
    if (allow.length && !allow.some((a) => a.toLowerCase() === normalized.toLowerCase())) {
      throw new ApiError(403, `${field} ${normalized} is not in policy.allowedRecipients`);
    }
    return normalized;
  }

  checkNativeCap(chainName, value) {
    const cap = this.config.policy.maxNativeValuePerTx?.[chainName];
    if (cap !== undefined && value > parseUnits(String(cap), 18)) {
      throw new ApiError(403, `value exceeds policy.maxNativeValuePerTx for ${chainName} (${cap})`);
    }
  }

  // Serialise sends per (chain, account) so concurrent requests get distinct nonces.
  async #withSendLock(key, fn) {
    const prev = this.#sendLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((r) => (release = r));
    const chained = prev.then(() => current);
    this.#sendLocks.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.#sendLocks.get(key) === chained) this.#sendLocks.delete(key);
    }
  }

  async #submit({ chainName, account, tx, dryRun, wait, summary }) {
    const chain = this.chain(chainName);
    const signer = this.signer(chain.name, account);
    const request = { ...tx, from: signer.address, chainId: chain.chainId };

    if (dryRun) {
      let gasLimit;
      try {
        gasLimit = await signer.estimateGas(request);
      } catch (err) {
        if (isRpcFailure(err)) throw err;
        throw new ApiError(422, `Transaction would fail: ${err.shortMessage || err.message}`);
      }
      const [fees, balance] = await Promise.all([signer.provider.getFeeData(), signer.provider.getBalance(signer.address)]);
      const maxFee = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
      // Nodes require value + gasLimit * maxFeePerGas up front.
      const required = (request.value ?? 0n) + gasLimit * maxFee;
      if (balance < required) {
        throw new ApiError(422, 'Insufficient funds for value plus network fee', {
          balance: formatEther(balance),
          required: formatEther(required),
        });
      }
      return {
        dryRun: true,
        chain: chain.name,
        ...summary,
        from: signer.address,
        to: request.to,
        value: (request.value ?? 0n).toString(),
        data: request.data ?? '0x',
        gasLimit: gasLimit.toString(),
        maxFeePerGas: maxFee.toString(),
        maxNetworkFee: formatEther(gasLimit * maxFee),
      };
    }

    const lockKey = `${chain.name}:${signer.address}`;
    return this.#withSendLock(lockKey, async () => {
      // The node's pending count can lag (and ethers caches it briefly), so also
      // remember the next nonce we handed out ourselves.
      const pending = await signer.provider.getTransactionCount(signer.address, 'pending');
      const local = this.#nextNonce.get(lockKey);
      const nonce = local && Date.now() - local.at < NONCE_MEMORY_MS ? Math.max(pending, local.nonce) : pending;
      let sent;
      try {
        sent = await signer.sendTransaction({ ...request, nonce });
      } catch (err) {
        this.#nextNonce.delete(lockKey);
        if (isRpcFailure(err)) throw err;
        throw new ApiError(422, `Transaction rejected: ${err.shortMessage || err.message}`);
      }
      this.#nextNonce.set(lockKey, { nonce: nonce + 1, at: Date.now() });
      const result = {
        chain: chain.name,
        ...summary,
        hash: sent.hash,
        from: sent.from,
        to: sent.to,
        nonce: sent.nonce,
        value: sent.value.toString(),
        status: 'pending',
      };
      if (wait) {
        const receipt = await sent.wait(1, 120_000);
        result.status = receipt.status === 1 ? 'success' : 'reverted';
        result.blockNumber = receipt.blockNumber;
        result.gasUsed = receipt.gasUsed.toString();
      }
      return result;
    });
  }

  async #tokenInfo(chainName, tokenAddress) {
    const token = new Contract(tokenAddress, ERC20_ABI, this.provider(chainName));
    try {
      const [decimals, symbol] = await Promise.all([token.decimals(), token.symbol().catch(() => null)]);
      return { token, decimals: Number(decimals), symbol };
    } catch (err) {
      if (isRpcFailure(err)) throw err;
      throw new ApiError(400, `${tokenAddress} does not look like an ERC-20 token on this chain`);
    }
  }

  // --- public operations -------------------------------------------------

  listChains() {
    return Object.entries(this.config.chains).map(([name, c]) => ({
      name,
      chainId: c.chainId,
      symbol: c.symbol,
      default: name === this.config.defaultChain,
    }));
  }

  listAccounts({ offset = 0, count = 5 } = {}) {
    offset = this.accountIndex(offset);
    count = Math.min(Math.max(Number(count) || 1, 1), 50);
    const last = Math.min(offset + count - 1, this.config.policy.maxAccountIndex);
    const accounts = [];
    for (let i = offset; i <= last; i++) {
      accounts.push({ account: i, address: this.node(i).address, path: this.node(i).path });
    }
    return accounts;
  }

  async balance({ chain: chainName, account, token }) {
    const chain = this.chain(chainName);
    const address = this.address(account);
    if (!token) {
      const wei = await this.provider(chain.name).getBalance(address);
      return { chain: chain.name, address, asset: chain.symbol, balance: formatEther(wei), raw: wei.toString() };
    }
    if (!isAddress(token)) throw new ApiError(400, 'token must be a valid 0x address');
    const info = await this.#tokenInfo(chain.name, getAddress(token));
    const raw = await info.token.balanceOf(address);
    return {
      chain: chain.name,
      address,
      token: getAddress(token),
      asset: info.symbol,
      decimals: info.decimals,
      balance: formatUnits(raw, info.decimals),
      raw: raw.toString(),
    };
  }

  async transfer({ chain: chainName, account, to, amount, token, dryRun = false, wait = false }) {
    const chain = this.chain(chainName);
    const recipient = this.checkRecipient(to);
    if (typeof amount !== 'string' && typeof amount !== 'number') {
      throw new ApiError(400, 'amount is required, as a decimal string like "0.01"');
    }

    if (!token) {
      const value = parseAmount(amount, 18);
      this.checkNativeCap(chain.name, value);
      return this.#submit({
        chainName: chain.name,
        account,
        tx: { to: recipient, value },
        dryRun,
        wait,
        summary: { type: 'native', asset: chain.symbol, amount: String(amount) },
      });
    }

    if (!isAddress(token)) throw new ApiError(400, 'token must be a valid 0x address');
    const tokenAddress = getAddress(token);
    const info = await this.#tokenInfo(chain.name, tokenAddress);
    const units = parseAmount(amount, info.decimals);
    return this.#submit({
      chainName: chain.name,
      account,
      tx: { to: tokenAddress, data: ERC20_IFACE.encodeFunctionData('transfer', [recipient, units]) },
      dryRun,
      wait,
      summary: { type: 'erc20', asset: info.symbol, token: tokenAddress, recipient, amount: String(amount) },
    });
  }

  async transferNft({ chain: chainName, account, to, contract, tokenId, amount = '1', standard = 'erc721', dryRun = false, wait = false }) {
    const chain = this.chain(chainName);
    const recipient = this.checkRecipient(to);
    if (!isAddress(contract)) throw new ApiError(400, 'contract must be a valid 0x address');
    const id = parseBigInt(tokenId, 'tokenId');
    const from = this.address(account);
    let data;
    if (standard === 'erc721') {
      data = ERC721_IFACE.encodeFunctionData('safeTransferFrom', [from, recipient, id]);
    } else if (standard === 'erc1155') {
      data = ERC1155_IFACE.encodeFunctionData('safeTransferFrom', [from, recipient, id, parseBigInt(amount, 'amount'), '0x']);
    } else {
      throw new ApiError(400, 'standard must be "erc721" or "erc1155"');
    }
    return this.#submit({
      chainName: chain.name,
      account,
      tx: { to: getAddress(contract), data },
      dryRun,
      wait,
      summary: { type: standard, contract: getAddress(contract), tokenId: id.toString(), recipient },
    });
  }

  async sendTransaction({ chain: chainName, account, to, data = '0x', value = '0', dryRun = false, wait = false }) {
    if (!this.config.policy.allowRawTransactions) throw new ApiError(403, 'Raw transactions are disabled by policy.allowRawTransactions');
    const chain = this.chain(chainName);
    const target = this.checkRecipient(to);
    if (!isHexString(data)) throw new ApiError(400, 'data must be 0x-prefixed hex');
    const wei = parseBigInt(value, 'value');
    this.checkNativeCap(chain.name, wei);
    return this.#submit({
      chainName: chain.name,
      account,
      tx: { to: target, data, value: wei },
      dryRun,
      wait,
      summary: { type: 'raw' },
    });
  }

  async signMessage({ account, message }) {
    if (typeof message !== 'string') throw new ApiError(400, 'message must be a string');
    const node = this.node(this.accountIndex(account));
    return { address: node.address, message, signature: await node.signMessage(message) };
  }

  async signTypedData({ account, domain, types, message }) {
    if (!domain || !types || !message) throw new ApiError(400, 'domain, types and message are required');
    const node = this.node(this.accountIndex(account));
    const { EIP712Domain, ...rest } = types;
    try {
      return { address: node.address, signature: await node.signTypedData(domain, rest, message) };
    } catch (err) {
      throw new ApiError(400, `Could not sign typed data: ${err.shortMessage || err.message}`);
    }
  }

  async transactionStatus({ chain: chainName, hash }) {
    const chain = this.chain(chainName);
    if (!isHexString(hash, 32)) throw new ApiError(400, 'hash must be a 32-byte 0x hex string');
    const provider = this.provider(chain.name);
    const [tx, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
    if (!tx) throw new ApiError(404, 'Transaction not found');
    return {
      chain: chain.name,
      hash,
      from: tx.from,
      to: tx.to,
      nonce: tx.nonce,
      value: tx.value.toString(),
      status: receipt ? (receipt.status === 1 ? 'success' : 'reverted') : 'pending',
      blockNumber: receipt?.blockNumber ?? null,
      gasUsed: receipt?.gasUsed?.toString() ?? null,
    };
  }

  // Drop references to key material. (JS cannot guarantee memory is zeroed.)
  destroy() {
    this.#nodes.clear();
    this.#mnemonic = null;
    for (const p of this.#providers.values()) p.destroy?.();
    this.#providers.clear();
  }
}

function parseAmount(amount, decimals) {
  let value;
  try {
    value = parseUnits(String(amount).trim(), decimals);
  } catch {
    throw new ApiError(400, `amount "${amount}" is not a valid decimal with at most ${decimals} decimals`);
  }
  if (value <= 0n) throw new ApiError(400, 'amount must be greater than zero');
  return value;
}

function parseBigInt(value, field) {
  try {
    const n = BigInt(value);
    if (n < 0n) throw new Error();
    return n;
  } catch {
    throw new ApiError(400, `${field} must be a non-negative integer (string or number)`);
  }
}

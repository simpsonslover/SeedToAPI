// Ethereum and EVM-compatible chains.

import {
  HDNodeWallet,
  JsonRpcProvider,
  Contract,
  Interface,
  getAddress,
  isAddress,
  isHexString,
  formatUnits,
  formatEther,
} from 'ethers';
import { ApiError, Policy, KeyedLock, isRpcFailure, errorMessage, parseAmount, parseBigInt } from './common.js';

// How long to trust our own record of the next nonce over the node's (in case a tx is dropped).
const NONCE_MEMORY_MS = 60_000;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
];
const ERC20_IFACE = new Interface(ERC20_ABI);
const ERC721_IFACE = new Interface(['function safeTransferFrom(address from, address to, uint256 tokenId)']);
const ERC1155_IFACE = new Interface([
  'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
]);

export const EVM_DEFAULT_PATH = "m/44'/60'/0'/0/{index}";

export class EvmChain {
  #master;
  #nodes = new Map();
  #provider;
  #lock = new KeyedLock();
  #nextNonce = new Map();

  constructor({ id, net, seed, policy }) {
    this.id = id;
    this.net = net;
    this.#master = HDNodeWallet.fromSeed(seed);
    this.policy = new Policy({ policy, chainId: id, decimals: 18, normalizeAddress: normalizeEvmAddress });
  }

  get provider() {
    this.#provider ??= new JsonRpcProvider(this.net.rpcUrl, this.net.chainId, { staticNetwork: true, cacheTimeout: -1 });
    return this.#provider;
  }

  path(index) {
    return (this.net.derivationPath || EVM_DEFAULT_PATH).replace('{index}', String(index));
  }

  node(index) {
    if (!this.#nodes.has(index)) this.#nodes.set(index, this.#master.derivePath(this.path(index)));
    return this.#nodes.get(index);
  }

  address(index) {
    return this.node(index).address;
  }

  signer(index) {
    return this.node(index).connect(this.provider);
  }

  async #submit({ account, tx, dryRun, wait, summary }) {
    const signer = this.signer(account);
    const request = { ...tx, from: signer.address, chainId: this.net.chainId };

    if (dryRun) {
      let gasLimit;
      try {
        gasLimit = await signer.estimateGas(request);
      } catch (err) {
        if (isRpcFailure(err)) throw err;
        throw new ApiError(422, `Transaction would fail: ${errorMessage(err)}`);
      }
      const [fees, balance] = await Promise.all([this.provider.getFeeData(), this.provider.getBalance(signer.address)]);
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
        chain: this.id,
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

    const lockKey = signer.address;
    return this.#lock.run(lockKey, async () => {
      // The node's pending count can lag, so also remember the next nonce we handed out.
      const pending = await this.provider.getTransactionCount(signer.address, 'pending');
      const local = this.#nextNonce.get(lockKey);
      const nonce = local && Date.now() - local.at < NONCE_MEMORY_MS ? Math.max(pending, local.nonce) : pending;
      let sent;
      try {
        sent = await signer.sendTransaction({ ...request, nonce });
      } catch (err) {
        this.#nextNonce.delete(lockKey);
        if (isRpcFailure(err)) throw err;
        throw new ApiError(422, `Transaction rejected: ${errorMessage(err)}`);
      }
      this.#nextNonce.set(lockKey, { nonce: nonce + 1, at: Date.now() });
      const result = {
        chain: this.id,
        ...summary,
        hash: sent.hash,
        from: sent.from,
        to: sent.to,
        nonce: sent.nonce,
        value: sent.value.toString(),
        status: 'pending',
        explorer: this.net.explorer ? this.net.explorer + sent.hash : undefined,
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

  // Accepts a contract address or a known symbol from the network's token list.
  async #token(token) {
    let address = token;
    let expectSymbol = null;
    const known = Object.entries(this.net.tokens || {}).find(([sym]) => sym.toLowerCase() === String(token).toLowerCase());
    if (known) [expectSymbol, address] = known;
    if (!isAddress(address)) {
      throw new ApiError(400, `token must be a 0x contract address or one of: ${Object.keys(this.net.tokens || {}).join(', ') || '(none listed)'}`);
    }
    address = getAddress(address);
    const contract = new Contract(address, ERC20_ABI, this.provider);
    let decimals, symbol;
    try {
      [decimals, symbol] = await Promise.all([contract.decimals(), contract.symbol().catch(() => null)]);
    } catch (err) {
      if (isRpcFailure(err)) throw err;
      throw new ApiError(400, `${address} does not look like an ERC-20 token on ${this.id}`);
    }
    // Guard against a wrong entry in the built-in token list.
    if (expectSymbol && symbol?.toLowerCase() !== expectSymbol.toLowerCase()) {
      throw new ApiError(502, `Token list mismatch: ${address} on ${this.id} reports symbol "${symbol}", expected ${expectSymbol}`);
    }
    return { address, contract, decimals: Number(decimals), symbol };
  }

  // --- operations ----------------------------------------------------------

  async balance({ account, token }) {
    const address = this.address(account);
    if (!token) {
      const wei = await this.provider.getBalance(address);
      return { chain: this.id, address, asset: this.net.symbol, balance: formatEther(wei), raw: wei.toString() };
    }
    const t = await this.#token(token);
    const raw = await t.contract.balanceOf(address);
    return {
      chain: this.id,
      address,
      token: t.address,
      asset: t.symbol,
      decimals: t.decimals,
      balance: formatUnits(raw, t.decimals),
      raw: raw.toString(),
    };
  }

  async transfer({ account, to, amount, token, dryRun, wait }) {
    const recipient = this.policy.recipient(to);
    if (!token) {
      const value = parseAmount(amount, 18);
      this.policy.nativeCap(value);
      return this.#submit({
        account,
        tx: { to: recipient, value },
        dryRun,
        wait,
        summary: { type: 'native', asset: this.net.symbol, amount: String(amount) },
      });
    }
    const t = await this.#token(token);
    const units = parseAmount(amount, t.decimals);
    return this.#submit({
      account,
      tx: { to: t.address, data: ERC20_IFACE.encodeFunctionData('transfer', [recipient, units]) },
      dryRun,
      wait,
      summary: { type: 'erc20', asset: t.symbol, token: t.address, recipient, amount: String(amount) },
    });
  }

  async transferNft({ account, to, contract, tokenId, amount = '1', standard = 'erc721', dryRun, wait }) {
    const recipient = this.policy.recipient(to);
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
      account,
      tx: { to: getAddress(contract), data },
      dryRun,
      wait,
      summary: { type: standard, contract: getAddress(contract), tokenId: id.toString(), recipient },
    });
  }

  async sendTransaction({ account, to, data = '0x', value = '0', dryRun, wait }) {
    const target = this.policy.recipient(to);
    if (!isHexString(data)) throw new ApiError(400, 'data must be 0x-prefixed hex');
    const wei = parseBigInt(value, 'value');
    this.policy.nativeCap(wei);
    return this.#submit({ account, tx: { to: target, data, value: wei }, dryRun, wait, summary: { type: 'raw' } });
  }

  async signMessage({ account, message }) {
    if (typeof message !== 'string') throw new ApiError(400, 'message must be a string');
    const node = this.node(account);
    return { chain: this.id, address: node.address, message, signature: await node.signMessage(message) };
  }

  async signTypedData({ account, domain, types, message }) {
    if (!domain || !types || !message) throw new ApiError(400, 'domain, types and message are required');
    const node = this.node(account);
    const { EIP712Domain, ...rest } = types;
    try {
      return { chain: this.id, address: node.address, signature: await node.signTypedData(domain, rest, message) };
    } catch (err) {
      throw new ApiError(400, `Could not sign typed data: ${errorMessage(err)}`);
    }
  }

  async transactionStatus({ hash }) {
    if (!isHexString(hash, 32)) throw new ApiError(400, 'hash must be a 32-byte 0x hex string');
    const [tx, receipt] = await Promise.all([this.provider.getTransaction(hash), this.provider.getTransactionReceipt(hash)]);
    if (!tx) throw new ApiError(404, 'Transaction not found');
    return {
      chain: this.id,
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

  destroy() {
    this.#nodes.clear();
    this.#master = null;
    this.#provider?.destroy();
  }
}

export function normalizeEvmAddress(address, field = 'address') {
  if (typeof address !== 'string' || !isAddress(address)) throw new ApiError(400, `${field} must be a valid 0x address`);
  return getAddress(address);
}

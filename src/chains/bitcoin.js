// Bitcoin-style UTXO chains (Bitcoin, Litecoin, Bitcoin testnet) using native
// SegWit (BIP-84, addresses starting bc1q / ltc1q / tb1q) and an Esplora API
// (mempool.space, litecoinspace.org, or your own Esplora/mempool instance).
//
// Like Sparrow, Electrum or BlueWallet, an "account" is a BIP-84 account
// (m/84'/coin'/account') with receive (…/0/i) and change (…/1/i) addresses.
// Balances and spending cover every used address, found by scanning with a gap limit.

import { HDKey } from '@scure/bip32';
import { p2wpkh, Address, OutScript, selectUTXO } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { formatUnits } from 'ethers';
import { ApiError, RpcError, Policy, KeyedLock, parseAmount } from './common.js';

const GAP_LIMIT = 20;
const SCAN_CONCURRENCY = 5;
const SCAN_CACHE_MS = 15_000;
// Outputs we just spent stay excluded this long, in case the API's mempool view lags.
const SPENT_MEMORY_MS = 10 * 60_000;
const RBF_SEQUENCE = 0xfffffffd;
const SPEED_TARGETS = { fast: '2', normal: '6', slow: '144' };
const MAX_FEE_RATE = 2000; // sat/vB; anything above is almost certainly a mistake

export class BitcoinChain {
  #master;
  #accounts = new Map();
  #scanCache = new Map();
  #recentlySpent = new Map();
  #lock = new KeyedLock();

  constructor({ id, net, seed, policy, fetchImpl = fetch }) {
    this.id = id;
    this.net = net;
    this.network = net.params;
    this.#master = HDKey.fromMasterSeed(seed);
    this.fetch = fetchImpl;
    this.apiUrl = net.apiUrl.replace(/\/$/, '');
    this.policy = new Policy({
      policy,
      chainId: id,
      decimals: 8,
      normalizeAddress: (a, field) => normalizeBitcoinAddress(a, this.network, field, net.name),
    });
  }

  // --- keys & addresses ----------------------------------------------------

  path(index) {
    return (this.net.derivationPath || `m/84'/${this.net.coinType}'/{index}'`).replace('{index}', String(index));
  }

  #account(index) {
    if (!this.#accounts.has(index)) this.#accounts.set(index, this.#master.derive(this.path(index)));
    return this.#accounts.get(index);
  }

  #key(index, branch, i) {
    const node = this.#account(index).deriveChild(branch).deriveChild(i);
    const pay = p2wpkh(node.publicKey, this.network);
    return { branch, i, address: pay.address, script: pay.script, node };
  }

  // First receive address of the account.
  address(index) {
    return this.#key(index, 0, 0).address;
  }

  // --- Esplora API ---------------------------------------------------------

  async #get(path) {
    let res;
    try {
      res = await this.fetch(this.apiUrl + path, { signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new RpcError(`Could not reach ${this.apiUrl}: ${err.cause?.code || err.message}`, err);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new RpcError(`${this.apiUrl}${path} returned HTTP ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async #broadcast(txHex) {
    let res;
    try {
      res = await this.fetch(this.apiUrl + '/tx', { method: 'POST', body: txHex, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new RpcError(`Could not reach ${this.apiUrl}: ${err.cause?.code || err.message}`, err);
    }
    const body = (await res.text()).trim();
    if (res.status >= 500) throw new RpcError(`Broadcast failed with HTTP ${res.status}: ${body}`);
    if (!res.ok) throw new ApiError(422, `Transaction rejected: ${body}`);
    return body;
  }

  // Scan one branch (receive or change) until GAP_LIMIT unused addresses in a row.
  async #scanBranch(index, branch) {
    const used = [];
    let lastUsed = -1;
    for (let start = 0; ; start += GAP_LIMIT) {
      const keys = Array.from({ length: GAP_LIMIT }, (_, k) => this.#key(index, branch, start + k));
      const stats = await mapLimit(keys, SCAN_CONCURRENCY, (k) => this.#get(`/address/${k.address}`));
      keys.forEach((k, n) => {
        const s = stats[n];
        if (!s) return;
        const txCount = (s.chain_stats?.tx_count || 0) + (s.mempool_stats?.tx_count || 0);
        if (txCount > 0) {
          used.push({ ...k, stats: s });
          lastUsed = k.i;
        }
      });
      if (start + GAP_LIMIT - 1 - lastUsed >= GAP_LIMIT) break;
    }
    return { used, nextUnused: lastUsed + 1 };
  }

  async #scan(index, { fresh = false } = {}) {
    const cached = this.#scanCache.get(index);
    if (!fresh && cached && Date.now() - cached.at < SCAN_CACHE_MS) return cached.value;
    const [receive, change] = await Promise.all([this.#scanBranch(index, 0), this.#scanBranch(index, 1)]);
    const value = { receive, change, used: [...receive.used, ...change.used] };
    this.#scanCache.set(index, { at: Date.now(), value });
    return value;
  }

  async #utxos(index) {
    const scan = await this.#scan(index, { fresh: true });
    const now = Date.now();
    for (const [outpoint, at] of this.#recentlySpent) if (now - at > SPENT_MEMORY_MS) this.#recentlySpent.delete(outpoint);
    const lists = await mapLimit(scan.used, SCAN_CONCURRENCY, (k) => this.#get(`/address/${k.address}/utxo`));
    const utxos = [];
    scan.used.forEach((k, n) => {
      for (const u of lists[n] || []) {
        if (this.#recentlySpent.has(`${u.txid}:${u.vout}`)) continue;
        utxos.push({ ...u, key: k });
      }
    });
    return { scan, utxos };
  }

  async #feeRate({ feeRate, speed = 'normal' }) {
    if (feeRate !== undefined) {
      const rate = Number(feeRate);
      if (!(rate > 0) || rate > MAX_FEE_RATE) throw new ApiError(400, `feeRate must be between 0 and ${MAX_FEE_RATE} sat/vB`);
      return rate;
    }
    const target = SPEED_TARGETS[speed];
    if (!target) throw new ApiError(400, 'speed must be "fast", "normal" or "slow" (or pass feeRate in sat/vB)');
    const estimates = (await this.#get('/fee-estimates')) || {};
    const rate = Number(estimates[target] ?? estimates['6'] ?? 1);
    return Math.min(Math.max(rate, 1), MAX_FEE_RATE);
  }

  // --- operations ----------------------------------------------------------

  async balance({ account, token }) {
    if (token) throw new ApiError(400, `${this.net.name} has no tokens; leave out "token"`);
    const scan = await this.#scan(account);
    let confirmed = 0n;
    let unconfirmed = 0n;
    for (const k of scan.used) {
      confirmed += BigInt(k.stats.chain_stats.funded_txo_sum - k.stats.chain_stats.spent_txo_sum);
      unconfirmed += BigInt(k.stats.mempool_stats.funded_txo_sum - k.stats.mempool_stats.spent_txo_sum);
    }
    const total = confirmed + unconfirmed;
    return {
      chain: this.id,
      address: this.address(account),
      receiveAddress: this.#key(account, 0, scan.receive.nextUnused).address,
      asset: this.net.symbol,
      balance: formatUnits(total, 8),
      confirmed: formatUnits(confirmed, 8),
      unconfirmed: formatUnits(unconfirmed, 8),
      raw: total.toString(),
      addressesUsed: scan.used.length,
    };
  }

  async transfer({ account, to, amount, token, dryRun, feeRate, speed }) {
    if (token) throw new ApiError(400, `${this.net.name} has no tokens; leave out "token"`);
    const recipient = this.policy.recipient(to);
    const sats = parseAmount(amount, 8);
    this.policy.nativeCap(sats);

    return this.#lock.run(String(account), async () => {
      const rate = await this.#feeRate({ feeRate, speed });
      const { scan, utxos } = await this.#utxos(account);
      const change = this.#key(account, 1, scan.change.nextUnused);
      const keysByScript = new Map(utxos.map((u) => [hex.encode(u.key.script), u.key]));
      const inputs = utxos.map((u) => ({
        txid: hex.decode(u.txid),
        index: u.vout,
        witnessUtxo: { script: u.key.script, amount: BigInt(u.value) },
        sequence: RBF_SEQUENCE,
      }));

      let selection;
      try {
        selection = selectUTXO(inputs, [{ address: recipient, amount: sats }], 'default', {
          feePerByte: BigInt(Math.ceil(rate)),
          changeAddress: change.address,
          network: this.network,
          createTx: true,
          bip69: true,
        });
      } catch (err) {
        throw new ApiError(400, `Could not build transaction: ${err.message}`);
      }
      if (!selection?.tx) {
        const total = utxos.reduce((s, u) => s + BigInt(u.value), 0n);
        throw new ApiError(422, 'Insufficient funds for amount plus network fee', {
          balance: formatUnits(total, 8),
          amount: String(amount),
          feeRate: rate,
        });
      }

      const tx = selection.tx;
      for (let i = 0; i < tx.inputsLength; i++) {
        const key = keysByScript.get(hex.encode(tx.getInput(i).witnessUtxo.script));
        tx.signIdx(key.node.privateKey, i);
      }
      tx.finalize();

      const summary = {
        chain: this.id,
        type: 'native',
        asset: this.net.symbol,
        amount: String(amount),
        from: this.address(account),
        to: recipient,
        fee: formatUnits(selection.fee, 8),
        feeRate: rate,
        vsize: tx.vsize,
        inputs: tx.inputsLength,
        changeAddress: selection.change ? change.address : null,
      };
      if (dryRun) return { dryRun: true, ...summary };

      const txid = await this.#broadcast(tx.hex);
      for (let i = 0; i < tx.inputsLength; i++) {
        const input = tx.getInput(i);
        this.#recentlySpent.set(`${hex.encode(input.txid)}:${input.index}`, Date.now());
      }
      this.#scanCache.delete(account);
      return { ...summary, hash: txid, status: 'pending', explorer: this.net.explorer ? this.net.explorer + txid : undefined };
    });
  }

  async transactionStatus({ hash }) {
    if (typeof hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hash)) throw new ApiError(400, 'hash must be a 64-character hex txid');
    const tx = await this.#get(`/tx/${hash.toLowerCase()}`);
    if (!tx) throw new ApiError(404, 'Transaction not found');
    return {
      chain: this.id,
      hash: tx.txid,
      status: tx.status?.confirmed ? 'success' : 'pending',
      blockNumber: tx.status?.block_height ?? null,
      fee: tx.fee !== undefined ? formatUnits(BigInt(tx.fee), 8) : null,
    };
  }

  destroy() {
    this.#accounts.clear();
    this.#master = null;
  }
}

export function normalizeBitcoinAddress(address, network, field = 'address', name = 'this network') {
  if (typeof address !== 'string') throw new ApiError(400, `${field} must be a ${name} address`);
  try {
    const decoded = Address(network).decode(address.trim());
    OutScript.encode(decoded);
    return Address(network).encode(decoded);
  } catch {
    throw new ApiError(400, `${field} is not a valid ${name} address`);
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

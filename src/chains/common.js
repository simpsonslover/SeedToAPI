// Shared helpers for all chain families.

import { parseUnits } from 'ethers';

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// The RPC node / block explorer API could not be reached or returned garbage.
export class RpcError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'RpcError';
    this.code = 'SERVER_ERROR';
  }
}

const RPC_FAILURE_CODES = new Set([
  'NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT', 'BAD_DATA', 'UNKNOWN_ERROR',
  'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT',
]);

// True when the error means the node could not be reached or misbehaved,
// as opposed to the node rejecting the transaction.
export function isRpcFailure(err) {
  return (
    err instanceof RpcError ||
    RPC_FAILURE_CODES.has(err?.code) ||
    RPC_FAILURE_CODES.has(err?.cause?.code) ||
    err?.name === 'FetchError'
  );
}

export function errorMessage(err) {
  return err?.shortMessage || err?.message || String(err);
}

export function parseAmount(amount, decimals) {
  if (typeof amount !== 'string' && typeof amount !== 'number') {
    throw new ApiError(400, 'amount is required, as a decimal string like "0.01"');
  }
  let value;
  try {
    value = parseUnits(String(amount).trim(), decimals);
  } catch {
    throw new ApiError(400, `amount "${amount}" is not a valid decimal with at most ${decimals} decimals`);
  }
  if (value <= 0n) throw new ApiError(400, 'amount must be greater than zero');
  return value;
}

export function parseBigInt(value, field) {
  try {
    const n = BigInt(value);
    if (n < 0n) throw new Error();
    return n;
  } catch {
    throw new ApiError(400, `${field} must be a non-negative integer (string or number)`);
  }
}

// Runs async functions one at a time per key (e.g. per sending address).
export class KeyedLock {
  #tails = new Map();

  async run(key, fn) {
    const prev = this.#tails.get(key) || Promise.resolve();
    let release;
    const current = new Promise((r) => (release = r));
    const tail = prev.then(() => current);
    this.#tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

// Recipient allowlist and per-transaction native caps from config.policy, for one chain.
export class Policy {
  constructor({ policy, chainId, decimals, normalizeAddress }) {
    this.policy = policy;
    this.chainId = chainId;
    this.decimals = decimals;
    this.normalizeAddress = normalizeAddress;
  }

  get hasAllowlist() {
    return (this.policy.allowedRecipients || []).length > 0;
  }

  get hasNativeCap() {
    return this.policy.maxNativeValuePerTx?.[this.chainId] !== undefined;
  }

  // Validate and normalize a destination address, then apply the allowlist.
  recipient(address, field = 'to') {
    const normalized = this.normalizeAddress(address, field);
    if (this.hasAllowlist) {
      const allowed = this.policy.allowedRecipients.some((entry) => {
        try {
          return this.normalizeAddress(entry) === normalized;
        } catch {
          return false; // an address for a different chain family
        }
      });
      if (!allowed) throw new ApiError(403, `${field} ${normalized} is not in policy.allowedRecipients`);
    }
    return normalized;
  }

  // value is in the chain's smallest unit (wei, satoshi, lamport).
  nativeCap(value) {
    const cap = this.policy.maxNativeValuePerTx?.[this.chainId];
    if (cap !== undefined && value > parseUnits(String(cap), this.decimals)) {
      throw new ApiError(403, `value exceeds policy.maxNativeValuePerTx for ${this.chainId} (${cap})`);
    }
  }
}

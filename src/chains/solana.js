// Solana: SOL, SPL tokens (Token and Token-2022), and signing pre-built transactions.
//
// Addresses use m/44'/501'/{index}'/0', the path Phantom, Solflare and Backpack use.

import { createHmac, createPrivateKey, sign as edSign } from 'node:crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SendTransactionError,
} from '@solana/web3.js';
import { base58 } from '@scure/base';
import { formatUnits } from 'ethers';
import { ApiError, RpcError, Policy, errorMessage, parseAmount } from './common.js';

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MINT_SIZE = 82;
const CONFIRM_TIMEOUT_MS = 90_000;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export const SOLANA_DEFAULT_PATH = "m/44'/501'/{index}'/0'";

export class SolanaChain {
  #seed;
  #keys = new Map();
  #connection;

  constructor({ id, net, seed, policy }) {
    this.id = id;
    this.net = net;
    this.#seed = seed;
    this.policy = new Policy({ policy, chainId: id, decimals: 9, normalizeAddress: normalizeSolanaAddress });
  }

  get connection() {
    this.#connection ??= new Connection(this.net.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true });
    return this.#connection;
  }

  path(index) {
    return (this.net.derivationPath || SOLANA_DEFAULT_PATH).replace('{index}', String(index));
  }

  keypair(index) {
    if (!this.#keys.has(index)) this.#keys.set(index, Keypair.fromSeed(slip10Ed25519(this.#seed, this.path(index))));
    return this.#keys.get(index);
  }

  address(index) {
    return this.keypair(index).publicKey.toBase58();
  }

  // Wrap a read-only RPC call so connectivity problems surface as 502s.
  async #rpc(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new RpcError(`Solana RPC error: ${errorMessage(err)}`, err);
    }
  }

  // Accepts a mint address or a known symbol from the network's token list.
  async #mint(token) {
    const known = Object.entries(this.net.tokens || {}).find(([sym]) => sym.toLowerCase() === String(token).toLowerCase());
    let mint;
    try {
      mint = new PublicKey(known ? known[1] : token);
    } catch {
      throw new ApiError(400, `token must be a mint address or one of: ${Object.keys(this.net.tokens || {}).join(', ') || '(none listed)'}`);
    }
    const info = await this.#rpc(() => this.connection.getAccountInfo(mint));
    const isTokenProgram = info && (info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID));
    if (!isTokenProgram || info.data.length < MINT_SIZE) throw new ApiError(400, `${mint.toBase58()} is not a token mint on ${this.id}`);
    return { mint, programId: info.owner, decimals: info.data[44], symbol: known?.[0] ?? null };
  }

  async #buildAndSend({ account, instructions, dryRun, wait, summary }) {
    const payer = this.keypair(account);
    const { blockhash, lastValidBlockHeight } = await this.#rpc(() => this.connection.getLatestBlockhash());
    const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([payer]);
    return this.#sendSigned({ tx, lastValidBlockHeight, dryRun, wait, summary: { ...summary, from: payer.publicKey.toBase58() } });
  }

  async #sendSigned({ tx, lastValidBlockHeight, dryRun, wait, summary }) {
    if (dryRun) {
      const [sim, fee] = await Promise.all([
        this.#rpc(() => this.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true })),
        this.#rpc(() => this.connection.getFeeForMessage(tx.message)),
      ]);
      if (sim.value.err) {
        throw new ApiError(422, `Transaction would fail: ${JSON.stringify(sim.value.err)}`, { logs: sim.value.logs });
      }
      return { dryRun: true, chain: this.id, ...summary, fee: fee.value === null ? null : formatUnits(BigInt(fee.value), 9) };
    }

    let signature;
    try {
      signature = await this.connection.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
    } catch (err) {
      if (err instanceof SendTransactionError) {
        throw new ApiError(422, `Transaction rejected: ${err.transactionError?.message || errorMessage(err)}`, { logs: err.logs });
      }
      throw new RpcError(`Solana RPC error: ${errorMessage(err)}`, err);
    }
    const result = {
      chain: this.id,
      ...summary,
      hash: signature,
      status: 'pending',
      explorer: this.net.explorer ? this.net.explorer + signature + (this.net.testnet ? '?cluster=devnet' : '') : undefined,
    };
    if (wait) Object.assign(result, await this.#waitFor(signature, lastValidBlockHeight));
    return result;
  }

  // Poll instead of using websocket subscriptions, which many RPC setups block.
  async #waitFor(signature, lastValidBlockHeight) {
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { value } = await this.#rpc(() => this.connection.getSignatureStatuses([signature]));
      const s = value[0];
      if (s?.err) return { status: 'failed', error: s.err, slot: s.slot };
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return { status: 'success', slot: s.slot };
      if (lastValidBlockHeight && (await this.#rpc(() => this.connection.getBlockHeight())) > lastValidBlockHeight) {
        return { status: 'expired' };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { status: 'pending' };
  }

  // --- operations ----------------------------------------------------------

  async balance({ account, token }) {
    const owner = this.keypair(account).publicKey;
    if (!token) {
      const lamports = await this.#rpc(() => this.connection.getBalance(owner));
      return { chain: this.id, address: owner.toBase58(), asset: this.net.symbol, balance: formatUnits(BigInt(lamports), 9), raw: String(lamports) };
    }
    const t = await this.#mint(token);
    const { value } = await this.#rpc(() => this.connection.getParsedTokenAccountsByOwner(owner, { mint: t.mint }));
    const raw = value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
    return {
      chain: this.id,
      address: owner.toBase58(),
      token: t.mint.toBase58(),
      asset: t.symbol,
      decimals: t.decimals,
      balance: formatUnits(raw, t.decimals),
      raw: raw.toString(),
    };
  }

  async transfer({ account, to, amount, token, dryRun, wait }) {
    const recipient = new PublicKey(this.policy.recipient(to));
    const owner = this.keypair(account).publicKey;

    if (!token) {
      const lamports = parseAmount(amount, 9);
      this.policy.nativeCap(lamports);
      return this.#buildAndSend({
        account,
        instructions: [SystemProgram.transfer({ fromPubkey: owner, toPubkey: recipient, lamports })],
        dryRun,
        wait,
        summary: { type: 'native', asset: this.net.symbol, amount: String(amount), to: recipient.toBase58() },
      });
    }

    const t = await this.#mint(token);
    const units = parseAmount(amount, t.decimals);
    const source = associatedTokenAddress(owner, t.mint, t.programId);
    const dest = associatedTokenAddress(recipient, t.mint, t.programId);
    return this.#buildAndSend({
      account,
      instructions: [
        // Creates the recipient's token account if it doesn't exist yet (paid by us, ~0.002 SOL).
        createAtaIdempotentInstruction(owner, dest, recipient, t.mint, t.programId),
        transferCheckedInstruction(source, t.mint, dest, owner, units, t.decimals, t.programId),
      ],
      dryRun,
      wait,
      summary: { type: 'spl', asset: t.symbol, token: t.mint.toBase58(), amount: String(amount), to: recipient.toBase58() },
    });
  }

  // On Solana an NFT is a token with supply 1, so this is a token transfer.
  async transferNft({ account, to, contract, amount = '1', dryRun, wait }) {
    if (!contract) throw new ApiError(400, 'contract must be the NFT mint address');
    return this.transfer({ account, to, amount: String(amount), token: contract, dryRun, wait });
  }

  // Sign and send a transaction built elsewhere (e.g. a swap API), given as base64.
  async sendTransaction({ account, transaction, dryRun, wait }) {
    if (this.policy.hasAllowlist || this.policy.hasNativeCap) {
      throw new ApiError(403, `Pre-built Solana transactions can't be checked against policy, so they are disabled while allowedRecipients or maxNativeValuePerTx.${this.id} is set`);
    }
    if (typeof transaction !== 'string') throw new ApiError(400, 'transaction must be a base64-encoded Solana transaction');
    let tx;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'));
    } catch {
      throw new ApiError(400, 'transaction is not a valid base64-encoded Solana transaction');
    }
    const kp = this.keypair(account);
    const signerKeys = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
    if (!signerKeys.some((k) => k.equals(kp.publicKey))) {
      throw new ApiError(400, `Transaction does not need a signature from account ${account} (${kp.publicKey.toBase58()})`);
    }
    tx.sign([kp]);
    return this.#sendSigned({ tx, dryRun, wait, summary: { type: 'raw', from: kp.publicKey.toBase58() } });
  }

  async signMessage({ account, message }) {
    if (typeof message !== 'string') throw new ApiError(400, 'message must be a string');
    const kp = this.keypair(account);
    const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, kp.secretKey.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
    const signature = edSign(null, Buffer.from(message, 'utf8'), key);
    return { chain: this.id, address: kp.publicKey.toBase58(), message, signature: base58.encode(signature) };
  }

  async transactionStatus({ hash }) {
    if (typeof hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(hash)) throw new ApiError(400, 'hash must be a base58 transaction signature');
    const { value } = await this.#rpc(() => this.connection.getSignatureStatuses([hash], { searchTransactionHistory: true }));
    const s = value[0];
    if (!s) throw new ApiError(404, 'Transaction not found');
    return {
      chain: this.id,
      hash,
      status: s.err ? 'failed' : s.confirmationStatus === 'processed' ? 'pending' : 'success',
      confirmationStatus: s.confirmationStatus,
      slot: s.slot,
      error: s.err ?? null,
    };
  }

  destroy() {
    this.#keys.clear();
    this.#seed = null;
  }
}

export function normalizeSolanaAddress(address, field = 'address') {
  try {
    if (typeof address !== 'string') throw new Error();
    const key = new PublicKey(address.trim());
    if (key.toBase58() !== address.trim()) throw new Error();
    return key.toBase58();
  } catch {
    throw new ApiError(400, `${field} is not a valid Solana address`);
  }
}

export function associatedTokenAddress(owner, mint, programId) {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), programId.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

function createAtaIdempotentInstruction(payer, ata, owner, mint, programId) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

function transferCheckedInstruction(source, mint, dest, owner, amount, decimals, programId) {
  const data = Buffer.alloc(10);
  data[0] = 12; // TransferChecked
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

// SLIP-0010 key derivation for ed25519 (hardened steps only).
export function slip10Ed25519(seed, path) {
  let I = createHmac('sha512', 'ed25519 seed').update(seed).digest();
  let key = I.subarray(0, 32);
  let chainCode = I.subarray(32);
  const segments = path.split('/');
  if (segments.shift() !== 'm') throw new Error(`Invalid derivation path ${path}`);
  for (const seg of segments) {
    if (!/^\d+'$/.test(seg)) throw new Error(`ed25519 derivation needs hardened segments only, got "${seg}" in ${path}`);
    const index = (Number(seg.slice(0, -1)) + 0x80000000) >>> 0;
    const data = Buffer.alloc(37);
    key.copy(data, 1);
    data.writeUInt32BE(index, 33);
    I = createHmac('sha512', chainCode).update(data).digest();
    key = I.subarray(0, 32);
    chainCode = I.subarray(32);
  }
  return Uint8Array.from(key);
}

// Solana against a mock JSON-RPC node that verifies every signature it receives.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import {
  PublicKey,
  SystemProgram,
  SystemInstruction,
  TransactionMessage,
  VersionedTransaction,
  Keypair,
} from '@solana/web3.js';
import { WalletService } from '../src/wallet.js';
import { DEFAULT_CONFIG, mergeChains } from '../src/config.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '../src/chains/solana.js';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RECIPIENT = Keypair.generate().publicKey.toBase58();
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

let server, wallet, config, me;
const balances = new Map();
const sent = [];

const ata = (owner, mint) =>
  PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), new PublicKey(mint).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0].toBase58();

function verifySignatures(tx) {
  const msg = tx.message.serialize();
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
  return signers.every((key, i) => ed25519.verify(tx.signatures[i], msg, key.toBytes()));
}

// Very small simulation: native transfers need balance; anything else succeeds.
function simulate(tx) {
  const keys = tx.message.staticAccountKeys;
  for (const ix of tx.message.compiledInstructions) {
    if (!keys[ix.programIdIndex].equals(SystemProgram.programId)) continue;
    const from = keys[ix.accountKeyIndexes[0]].toBase58();
    const lamports = Buffer.from(ix.data).readBigUInt64LE(4);
    if ((balances.get(from) ?? 0n) < lamports + 5000n) return { InstructionError: [0, { Custom: 1 }] };
  }
  return null;
}

function rpc(method, params) {
  const ctx = (value) => ({ context: { slot: 100 }, value });
  switch (method) {
    case 'getBalance':
      return ctx(Number(balances.get(params[0]) ?? 0n));
    case 'getLatestBlockhash':
      return ctx({ blockhash: BLOCKHASH, lastValidBlockHeight: 1000 });
    case 'getBlockHeight':
      return 900;
    case 'getFeeForMessage':
      return ctx(5000);
    case 'getAccountInfo': {
      if (params[0] !== USDC) return ctx(null);
      const data = Buffer.alloc(82);
      data[44] = 6; // decimals
      data[45] = 1; // initialized
      return ctx({ data: [data.toString('base64'), 'base64'], executable: false, lamports: 1, owner: TOKEN_PROGRAM_ID.toBase58(), rentEpoch: 0, space: 82 });
    }
    case 'getTokenAccountsByOwner':
      return ctx(
        params[1].mint === USDC && params[0] === me
          ? [{
              pubkey: ata(me, USDC),
              account: {
                data: { program: 'spl-token', parsed: { type: 'account', info: { mint: USDC, owner: me, tokenAmount: { amount: '25500000', decimals: 6, uiAmount: 25.5, uiAmountString: '25.5' } } }, space: 165 },
                executable: false,
                lamports: 2039280,
                owner: TOKEN_PROGRAM_ID.toBase58(),
                rentEpoch: 0,
                space: 165,
              },
            }]
          : [],
      );
    case 'simulateTransaction': {
      const tx = VersionedTransaction.deserialize(Buffer.from(params[0], 'base64'));
      return ctx({ err: simulate(tx), logs: [], accounts: null, unitsConsumed: 300, returnData: null });
    }
    case 'sendTransaction': {
      const tx = VersionedTransaction.deserialize(Buffer.from(params[0], 'base64'));
      if (!verifySignatures(tx)) throw { code: -32003, message: 'Transaction signature verification failure' };
      const err = simulate(tx);
      if (err) throw { code: -32002, message: 'Transaction simulation failed: insufficient lamports', data: { err, logs: ['insufficient lamports'], accounts: null, unitsConsumed: 0 } };
      sent.push(tx);
      return base58.encode(tx.signatures[0]);
    }
    case 'getSignatureStatuses':
      return ctx(params[0].map((sig) => (sent.some((t) => base58.encode(t.signatures[0]) === sig) ? { slot: 101, confirmations: 1, err: null, confirmationStatus: 'confirmed' } : null)));
    default:
      throw { code: -32601, message: `Method not found: ${method}` };
  }
}

before(async () => {
  server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { id, method, params } = JSON.parse(body);
    let reply;
    try {
      reply = { jsonrpc: '2.0', id, result: rpc(method, params) };
    } catch (error) {
      reply = { jsonrpc: '2.0', id, error };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  config = {
    ...DEFAULT_CONFIG,
    chains: mergeChains({ solana: { rpcUrl: `http://127.0.0.1:${server.address().port}` } }),
    policy: { ...DEFAULT_CONFIG.policy },
  };
  wallet = new WalletService({ mnemonic: ABANDON, config, enabledChains: ['solana'] });
  me = wallet.chain('solana').address(0);
  balances.set(me, 2_000_000_000n);
});

after(() => server?.close());

test('SOL and token balances (token by symbol)', async () => {
  const sol = await wallet.balance({ chain: 'sol' });
  assert.equal(sol.balance, '2.0');
  const usdc = await wallet.balance({ chain: 'solana', token: 'usdc' });
  assert.equal(usdc.balance, '25.5');
  assert.equal(usdc.decimals, 6);
  assert.equal(usdc.token, USDC);
});

test('dry run reports the fee and sends nothing', async () => {
  const r = await wallet.transfer({ chain: 'solana', to: RECIPIENT, amount: '0.5', dryRun: true });
  assert.equal(r.fee, '0.000005');
  assert.equal(sent.length, 0);
});

test('sends SOL with a valid signature', async () => {
  const r = await wallet.transfer({ chain: 'solana', to: RECIPIENT, amount: '0.5', wait: true });
  assert.equal(r.status, 'success');
  const tx = sent.at(-1);
  assert.equal(r.hash, base58.encode(tx.signatures[0]));
  const ix = TransactionMessage.decompile(tx.message).instructions[0];
  const decoded = SystemInstruction.decodeTransfer(ix);
  assert.equal(decoded.fromPubkey.toBase58(), me);
  assert.equal(decoded.toPubkey.toBase58(), RECIPIENT);
  assert.equal(decoded.lamports, 500_000_000n);
});

test('sends USDC, creating the recipient token account if needed', async () => {
  const r = await wallet.transfer({ chain: 'solana', to: RECIPIENT, amount: '1.25', token: 'USDC' });
  assert.equal(r.type, 'spl');
  const [create, transfer] = TransactionMessage.decompile(sent.at(-1).message).instructions;
  assert.ok(create.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  assert.deepEqual([...create.data], [1]);
  assert.equal(create.keys[1].pubkey.toBase58(), ata(RECIPIENT, USDC));
  assert.ok(transfer.programId.equals(TOKEN_PROGRAM_ID));
  assert.equal(transfer.data[0], 12);
  assert.equal(transfer.data.readBigUInt64LE(1), 1_250_000n);
  assert.equal(transfer.data[9], 6);
  assert.equal(transfer.keys[0].pubkey.toBase58(), ata(me, USDC));
  assert.equal(transfer.keys[2].pubkey.toBase58(), ata(RECIPIENT, USDC));
  assert.equal(transfer.keys[3].pubkey.toBase58(), me);
});

test('insufficient funds is a 422 for both dry runs and sends', async () => {
  await assert.rejects(wallet.transfer({ chain: 'solana', to: RECIPIENT, amount: '50', dryRun: true }), { status: 422 });
  await assert.rejects(wallet.transfer({ chain: 'solana', to: RECIPIENT, amount: '50' }), { status: 422 });
});

test('signs a transaction built elsewhere', async () => {
  const message = new TransactionMessage({
    payerKey: new PublicKey(me),
    recentBlockhash: BLOCKHASH,
    instructions: [SystemProgram.transfer({ fromPubkey: new PublicKey(me), toPubkey: new PublicKey(RECIPIENT), lamports: 1000 })],
  }).compileToV0Message();
  const unsigned = Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
  const r = await wallet.sendTransaction({ chain: 'solana', transaction: unsigned });
  assert.equal(r.hash, base58.encode(sent.at(-1).signatures[0]));

  const someoneElse = new TransactionMessage({ payerKey: new PublicKey(RECIPIENT), recentBlockhash: BLOCKHASH, instructions: [] }).compileToV0Message();
  const foreign = Buffer.from(new VersionedTransaction(someoneElse).serialize()).toString('base64');
  await assert.rejects(wallet.sendTransaction({ chain: 'solana', transaction: foreign }), { status: 400 });

  config.policy.allowedRecipients = [RECIPIENT];
  try {
    await assert.rejects(wallet.sendTransaction({ chain: 'solana', transaction: unsigned }), { status: 403 });
  } finally {
    config.policy.allowedRecipients = [];
  }
});

test('signs messages with ed25519', async () => {
  const r = await wallet.signMessage({ chain: 'solana', message: 'hello' });
  assert.ok(ed25519.verify(base58.decode(r.signature), Buffer.from('hello'), new PublicKey(me).toBytes()));
});

test('rejects invalid addresses', async () => {
  await assert.rejects(wallet.transfer({ chain: 'solana', to: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', amount: '0.1' }), { status: 400 });
  await assert.rejects(wallet.transfer({ chain: 'solana', to: 'not-an-address', amount: '0.1' }), { status: 400 });
  await assert.rejects(wallet.balance({ chain: 'solana', token: RECIPIENT }), { status: 400 });
});

test('transaction status', async () => {
  const sig = base58.encode(sent[0].signatures[0]);
  assert.equal((await wallet.transactionStatus({ chain: 'solana', hash: sig })).status, 'success');
  await assert.rejects(wallet.transactionStatus({ chain: 'solana', hash: base58.encode(new Uint8Array(64).fill(7)) }), { status: 404 });
});

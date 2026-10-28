// Bitcoin sends against a mock Esplora API. Signatures are checked independently
// with node:crypto, so a broadcast transaction is known to be valid.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Transaction, OutScript, Address, NETWORK, p2wpkh } from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { Mnemonic, getBytes } from 'ethers';
import { WalletService } from '../src/wallet.js';
import { DEFAULT_CONFIG, mergeChains } from '../src/config.js';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECIPIENT = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g';
let server, wallet, btc, broadcasts, addresses;

const stats = (funded, spent = 0, txs = 1) => ({
  chain_stats: { funded_txo_sum: funded, spent_txo_sum: spent, tx_count: txs },
  mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
});

before(async () => {
  broadcasts = [];
  addresses = new Map();
  server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    let m;
    if (req.url === '/fee-estimates') return send(200, { 2: 20.5, 6: 10, 144: 2 });
    if ((m = req.url.match(/^\/address\/(\w+)\/utxo$/))) return send(200, addresses.get(m[1])?.utxos || []);
    if ((m = req.url.match(/^\/address\/(\w+)$/))) return send(200, addresses.get(m[1])?.stats || stats(0, 0, 0));
    if (req.method === 'POST' && req.url === '/tx') {
      let body = '';
      for await (const chunk of req) body += chunk;
      broadcasts.push(body);
      return send(200, Transaction.fromRaw(hex.decode(body)).id);
    }
    if ((m = req.url.match(/^\/tx\/(\w+)$/))) {
      return m[1] === 'a'.repeat(64)
        ? send(200, { txid: m[1], fee: 1500, status: { confirmed: true, block_height: 900000 } })
        : send(404, 'Transaction not found');
    }
    send(404, 'not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const config = {
    ...DEFAULT_CONFIG,
    chains: mergeChains({ bitcoin: { apiUrl: `http://127.0.0.1:${server.address().port}` } }),
    policy: { ...DEFAULT_CONFIG.policy, maxNativeValuePerTx: { bitcoin: '0.01' } },
  };
  wallet = new WalletService({ mnemonic: ABANDON, config, enabledChains: ['bitcoin'] });
  btc = wallet.chain('bitcoin');

  // Funds on receive addresses 0 and 5; change address 0 was used and spent.
  const receive0 = btc.address(0);
  addresses.set(receive0, {
    stats: stats(50_000),
    utxos: [{ txid: '11'.repeat(32), vout: 0, value: 50_000, status: { confirmed: true } }],
  });
  const receive5 = keyAddress(0, 5);
  addresses.set(receive5, {
    stats: stats(30_000),
    utxos: [{ txid: '22'.repeat(32), vout: 1, value: 30_000, status: { confirmed: true } }],
  });
  addresses.set(keyAddress(1, 0), { stats: stats(10_000, 10_000, 2), utxos: [] });
});

after(() => server?.close());

// Derive addresses independently of the code under test.
function keyAddress(branch, i) {
  const seed = getBytes(Mnemonic.fromPhrase(ABANDON).computeSeed());
  return p2wpkh(HDKey.fromMasterSeed(seed).derive(`m/84'/0'/0'/${branch}/${i}`).publicKey).address;
}

const script = (address) => hex.encode(OutScript.encode(Address(NETWORK).decode(address)));

function verifyInputs(tx, prevouts) {
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const [sigWithType, pubkey] = input.finalScriptWitness;
    const prev = prevouts[hex.encode(input.txid)];
    const pkh = OutScript.decode(p2wpkh(pubkey).script).hash;
    const sighash = tx.preimageWitnessV0(i, OutScript.encode({ type: 'pkh', hash: pkh }), 1, BigInt(prev.value));
    const ok = secp256k1.verify(sigWithType.slice(0, -1), sighash, pubkey, { prehash: false, format: 'der', lowS: true });
    assert.ok(ok, `input ${i} signature`);
    assert.equal(p2wpkh(pubkey).address, prev.address, `input ${i} spends our address`);
  }
}

test('balance covers every used address', async () => {
  const b = await btc.balance({ account: 0 });
  assert.equal(b.balance, '0.0008');
  assert.equal(b.addressesUsed, 3);
  assert.equal(b.receiveAddress, keyAddress(0, 6));
});

test('dry run picks inputs and fee without broadcasting', async () => {
  const r = await wallet.transfer({ chain: 'btc', to: RECIPIENT, amount: '0.0006', dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.inputs, 2);
  assert.equal(r.feeRate, 10);
  assert.ok(Number(r.fee) > 0 && Number(r.fee) < 0.0001, r.fee);
  assert.equal(broadcasts.length, 0);
});

test('send builds a valid signed transaction with change to the next change address', async () => {
  const r = await wallet.transfer({ chain: 'bitcoin', to: RECIPIENT, amount: '0.0006', speed: 'fast' });
  assert.equal(r.status, 'pending');
  assert.equal(r.feeRate, 20.5);
  assert.equal(broadcasts.length, 1);
  const tx = Transaction.fromRaw(hex.decode(broadcasts[0]));
  assert.equal(r.hash, tx.id);

  const outputs = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i));
  const recipientScript = script(RECIPIENT);
  const changeScript = script(keyAddress(1, 1));
  assert.equal(outputs.find((o) => hex.encode(o.script) === recipientScript).amount, 60_000n);
  const change = outputs.find((o) => hex.encode(o.script) === changeScript);
  assert.ok(change, 'change goes to change address 1');
  const fee = 80_000n - 60_000n - change.amount;
  assert.equal(r.fee, (Number(fee) / 1e8).toString());
  assert.ok(Number(fee) >= Math.ceil(20.5) * tx.vsize - 2, `fee ${fee} for vsize ${tx.vsize}`);

  verifyInputs(tx, {
    ['11'.repeat(32)]: { value: 50_000, address: btc.address(0) },
    ['22'.repeat(32)]: { value: 30_000, address: keyAddress(0, 5) },
  });
  for (let i = 0; i < tx.inputsLength; i++) assert.equal(tx.getInput(i).sequence, 0xfffffffd, 'RBF enabled');
});

test('coins just spent are not reused before the API catches up', async () => {
  await assert.rejects(wallet.transfer({ chain: 'bitcoin', to: RECIPIENT, amount: '0.0001' }), { status: 422 });
});

test('rejects wrong-network addresses, bad amounts, and policy breaches', async () => {
  await assert.rejects(wallet.transfer({ chain: 'bitcoin', to: 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh', amount: '0.0001' }), { status: 400 });
  await assert.rejects(wallet.transfer({ chain: 'bitcoin', to: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', amount: '0.0001' }), { status: 400 });
  await assert.rejects(wallet.transfer({ chain: 'bitcoin', to: RECIPIENT, amount: '0.000000001' }), { status: 400 });
  await assert.rejects(wallet.transfer({ chain: 'bitcoin', to: RECIPIENT, amount: '0.02' }), { status: 403 });
  await assert.rejects(wallet.transfer({ chain: 'bitcoin', to: RECIPIENT, amount: '0.0001', token: 'USDC' }), { status: 400 });
  await assert.rejects(wallet.transfer({ chain: 'bitcoin', to: RECIPIENT, amount: '0.0001', feeRate: 0 }), { status: 400 });
  await assert.rejects(wallet.signMessage({ chain: 'bitcoin', message: 'hi' }), { status: 400 });
});

test('transaction status', async () => {
  const s = await wallet.transactionStatus({ chain: 'bitcoin', hash: 'a'.repeat(64) });
  assert.equal(s.status, 'success');
  assert.equal(s.blockNumber, 900000);
  await assert.rejects(wallet.transactionStatus({ chain: 'bitcoin', hash: 'b'.repeat(64) }), { status: 404 });
});


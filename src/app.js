// HTTP API.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ApiError, isRpcFailure } from './wallet.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function createApp(keeper, { log = console } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((body) => res.json(body), next);

  // Setup and unlock take the seed or the passphrase, so by default they only
  // accept connections from this machine.
  const localOnly = (req, res, next) => {
    if (keeper.config.allowRemoteSetup || LOOPBACK.has(req.socket.remoteAddress)) return next();
    next(new ApiError(403, 'This endpoint only accepts connections from localhost'));
  };

  const auth = (req, res, next) => {
    const header = req.get('authorization') || '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : req.get('x-api-key');
    if (!keeper.checkApiKey(key)) return next(new ApiError(401, 'Missing or invalid API key'));
    next();
  };

  const unlocked = (req, res, next) => {
    if (keeper.state !== 'unlocked') return next(new ApiError(423, `Wallet is ${keeper.state}. POST /unlock with your passphrase first.`));
    next();
  };

  // --- web UI + lifecycle -------------------------------------------------

  app.get('/', (req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));

  app.get('/status', (req, res) => res.json({ state: keeper.state }));

  app.post(
    '/setup',
    localOnly,
    wrap(async (req) => {
      const { mnemonic, passphrase, bip39Passphrase } = req.body || {};
      const result = await keeper.setup({ mnemonic, passphrase, bip39Passphrase });
      log.info?.(`Wallet set up. Account 0 is ${result.firstAddress}`);
      return {
        ...result,
        note: 'Save this API key now. It is not stored anywhere in readable form and cannot be shown again.',
      };
    }),
  );

  app.post(
    '/unlock',
    localOnly,
    wrap(async (req) => {
      await keeper.unlock(req.body?.passphrase);
      return { state: keeper.state };
    }),
  );

  app.post(
    '/lock',
    auth,
    wrap(async () => {
      keeper.lock();
      return { state: keeper.state };
    }),
  );

  // --- wallet API ---------------------------------------------------------

  const v1 = express.Router();
  v1.use(auth);

  v1.post(
    '/api-key/rotate',
    localOnly,
    wrap((req) => keeper.rotateApiKey(req.body?.passphrase)),
  );

  v1.use(unlocked);
  const w = () => keeper.wallet;

  v1.get('/chains', wrap(() => ({ chains: w().listChains() })));
  v1.get('/accounts', wrap((req) => ({ accounts: w().listAccounts(req.query) })));
  v1.get('/balance', wrap((req) => w().balance(req.query)));
  v1.post('/transfer', wrap((req) => w().transfer(body(req))));
  v1.post('/nft/transfer', wrap((req) => w().transferNft(body(req))));
  v1.post('/transactions', wrap((req) => w().sendTransaction(body(req))));
  v1.get('/transactions/:hash', wrap((req) => w().transactionStatus({ chain: req.query.chain, hash: req.params.hash })));
  v1.post('/sign/message', wrap((req) => w().signMessage(body(req))));
  v1.post('/sign/typed-data', wrap((req) => w().signTypedData(body(req))));

  app.use('/v1', v1);

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: err.message, ...(err.details && { details: err.details }) });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    if (isRpcFailure(err)) {
      log.warn?.(`RPC error: ${err.shortMessage || err.message}`);
      return res.status(502).json({ error: `RPC error: ${err.shortMessage || err.message}` });
    }
    log.error?.(err);
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}

function body(req) {
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ApiError(400, 'Expected a JSON object body');
  return b;
}

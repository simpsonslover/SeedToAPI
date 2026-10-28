# SeedToAPI

A small server you run yourself. You give it your 12- or 24-word seed phrase once, and it gives you an HTTP API to check balances, send coins and tokens, move NFTs, call contracts, and sign messages from that wallet.

It works on Ethereum and any EVM chain (Base, Arbitrum, Optimism, Polygon, BNB Chain, testnets, or any RPC you add). It uses the standard derivation path `m/44'/60'/0'/0/N`, so account 0 is the same address MetaMask, Rabby, or Ledger shows for that seed.

> **Read [Security](#security) first.** Anyone with your API key can move your funds. Try it on a testnet or with a fresh, lightly funded seed before pointing it at real money.

## Quick start

Requires Node.js 20+.

```bash
npm install
```

```bash
npm start
```

Open http://127.0.0.1:8787 **in a browser on the same machine**, paste your seed, and pick a passphrase (12+ characters). You get:

- **An API key** (`sk_...`), shown once. Save it.
- **Your account 0 address.** Check it matches your wallet.

To do setup in the terminal instead (seed input is hidden):

```bash
npm run setup
```

The seed is encrypted with your passphrase and saved to `data/vault.json`. After a restart the wallet is **locked**. Unlock it from the web page, with `POST /unlock`, or start the server with the passphrase in the environment:

```bash
SEEDTOAPI_PASSPHRASE='your passphrase' npm start
```

## Using the API

Send the key as `Authorization: Bearer sk_...` (or the `X-API-Key` header). Amounts are decimal strings in normal units: `"0.05"` means 0.05 ETH, or 0.05 of a token. `account` is the HD index (default `0`). `chain` defaults to `defaultChain` in the config.

```bash
export KEY=sk_...
```

```bash
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:8787/v1/balance?chain=base"
```

**Send ETH (or the chain's native coin).** Use `"dryRun": true` first to check gas and funds without sending:

```bash
curl -X POST http://127.0.0.1:8787/v1/transfer \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"chain":"base","to":"0xRecipient...","amount":"0.01","dryRun":true}'
```

**Send an ERC-20 token** (USDC on Base here). Decimals are looked up automatically:

```bash
curl -X POST http://127.0.0.1:8787/v1/transfer \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"chain":"base","to":"0xRecipient...","amount":"25","token":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}'
```

**Send an NFT:**

```bash
curl -X POST http://127.0.0.1:8787/v1/nft/transfer \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"chain":"ethereum","to":"0xRecipient...","contract":"0xNftContract...","tokenId":"1234","standard":"erc721"}'
```

### Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/` | Web page for setup, unlock and quick tests |
| GET | `/status` | `uninitialized`, `locked` or `unlocked` (no auth) |
| POST | `/setup` | `{mnemonic, passphrase, bip39Passphrase?}` → API key. Localhost only, once |
| POST | `/unlock` | `{passphrase}`. Localhost only |
| POST | `/lock` | Forget the decrypted seed until the next unlock |
| GET | `/v1/chains` | Configured chains |
| GET | `/v1/accounts?offset=0&count=5` | Derived addresses |
| GET | `/v1/balance?chain=&account=&token=` | Native balance, or ERC-20 balance if `token` is given |
| POST | `/v1/transfer` | `{chain, account, to, amount, token?, dryRun?, wait?}` native coin or ERC-20 |
| POST | `/v1/nft/transfer` | `{chain, account, to, contract, tokenId, standard: "erc721"\|"erc1155", amount?, dryRun?, wait?}` |
| POST | `/v1/transactions` | `{chain, account, to, data, value (wei), dryRun?, wait?}` any contract call |
| GET | `/v1/transactions/:hash?chain=` | Status of a transaction |
| POST | `/v1/sign/message` | `{account, message}` EIP-191 signature |
| POST | `/v1/sign/typed-data` | `{account, domain, types, message}` EIP-712 signature |
| POST | `/v1/api-key/rotate` | `{passphrase}` issues a new key; the old one stops working. Localhost only |

Send endpoints return as soon as the transaction is broadcast (`"status": "pending"`). Pass `"wait": true` to wait for one confirmation. Errors come back as `{"error": "..."}` with a 4xx/5xx status: 401 bad key, 403 blocked by policy, 422 the transaction would fail (with details for insufficient funds), 423 wallet locked, 502 RPC unreachable.

## Configuration

Copy `config.example.json` to `config.json` and edit it. Everything is optional.

- **`chains`**: add chains or override RPC URLs. The built-in defaults use free public RPCs, which are rate-limited. For real use, put your own Alchemy, Infura, QuickNode, or self-hosted node URL here.
- **`defaultChain`**: used when a request leaves out `chain`. Defaults to `sepolia` (a testnet) so nothing real moves by accident.
- **`policy.allowedRecipients`**: if set, transfers and contract calls can only go to these addresses. Strongly recommended if the API key lives in another app.
- **`policy.maxNativeValuePerTx`**: per-chain cap on native coin per transaction, e.g. `{"ethereum": "0.5"}`.
- **`policy.allowRawTransactions`**: set `false` to turn off `/v1/transactions` (arbitrary contract calls such as token approvals).
- **`derivationPath`**: change it if your wallet uses a non-standard path. `{index}` is replaced by the account number.

Environment overrides: `SEEDTOAPI_HOST`, `SEEDTOAPI_PORT`, `SEEDTOAPI_VAULT`, `SEEDTOAPI_DEFAULT_CHAIN`, `SEEDTOAPI_CONFIG`, `SEEDTOAPI_PASSPHRASE`.

## Security

What it does:

- The seed is never stored in plaintext. It is encrypted with AES-256-GCM using a key derived from your passphrase with scrypt (N=2^17). The vault file is created with `0600` permissions.
- The API key is random (256 bits) and only its SHA-256 hash is stored. The hash is bound to the ciphertext, so editing the file to swap in another key breaks decryption.
- It listens on `127.0.0.1` only by default. Setup, unlock and key rotation only accept connections from localhost.
- No CORS headers are sent, so other websites open in your browser can't call the API.
- The decrypted seed lives only in memory while unlocked. `POST /lock` or stopping the server drops it.

What you need to do:

- **Treat the API key like the seed.** Anyone holding it can send everything in the wallet.
- **Don't expose the port to the internet as-is.** To reach it from another machine, use an SSH tunnel, Tailscale/WireGuard, or a reverse proxy with HTTPS. If you set `SEEDTOAPI_HOST=0.0.0.0` you are responsible for TLS and firewalling. Don't run setup through a reverse proxy: the proxy connects from localhost, so the localhost-only check would pass for remote users.
- **Use `allowedRecipients` and `maxNativeValuePerTx`** when another program holds the key.
- **Prefer a dedicated hot wallet.** Keep long-term holdings on a seed that never touches a server.
- **Back up your seed separately.** If you lose the passphrase, the vault can't be recovered. You can always run setup again from the seed.
- `SEEDTOAPI_PASSPHRASE` is convenient, but it puts the passphrase wherever your environment is stored (systemd unit, Docker config, shell history). Unlocking by hand after each restart is safer.

To start over, stop the server and delete `data/vault.json`.

## Development

```bash
npm test
```

The tests start a local Ganache chain, deploy a test ERC-20 and NFT, and run real transfers through the API.

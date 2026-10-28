# SeedToAPI

A small server you run yourself. You give it your 12- or 24-word seed phrase once, **pick which coins you want**, and it gives you an HTTP API to check balances, send coins and tokens, move NFTs, and sign messages from that wallet.

> **Read [Security](#security) first.** Anyone with your API key can move your funds on the coins you enabled. Try it on a testnet or with a fresh, lightly funded seed before pointing it at real money.

## Supported coins

| Coin | Network (`chain`) | Built-in tokens (use by symbol) | NFTs | Address path (same as) |
|---|---|---|---|---|
| **Bitcoin** (BTC) | `bitcoin`, `btc` | – | – | `m/84'/0'/N'` native SegWit `bc1q…` (Sparrow, Electrum, BlueWallet) |
| **Litecoin** (LTC) | `litecoin`, `ltc` | – | – | `m/84'/2'/N'` native SegWit `ltc1q…` |
| **Ethereum** (ETH) | `ethereum`, `eth` | USDC, USDT, DAI, WETH | ERC-721, ERC-1155 | `m/44'/60'/0'/0/N` (MetaMask, Rabby, Ledger) |
| **Solana** (SOL) | `solana`, `sol` | USDC, USDT | yes (SPL) | `m/44'/501'/N'/0'` (Phantom, Solflare, Backpack) |
| **Base** (ETH) | `base` | USDC, WETH | ERC-721, ERC-1155 | same as Ethereum |
| **Arbitrum One** (ETH) | `arbitrum`, `arb` | USDC | ERC-721, ERC-1155 | same as Ethereum |
| **OP Mainnet** (ETH) | `optimism`, `op` | USDC, WETH | ERC-721, ERC-1155 | same as Ethereum |
| **Polygon** (POL) | `polygon`, `pol`, `matic` | USDC | ERC-721, ERC-1155 | same as Ethereum |
| **BNB Smart Chain** (BNB) | `bsc`, `bnb` | USDT | ERC-721, ERC-1155 | same as Ethereum |
| **Avalanche C-Chain** (AVAX) | `avalanche`, `avax` | USDC, USDT | ERC-721, ERC-1155 | same as Ethereum |

Testnets, with free coins from faucets: `bitcoin-testnet` (Testnet4), `sepolia`, `base-sepolia`, `solana-devnet`.

- **Any other token** works by its address: an ERC-20 contract address on EVM chains, or an SPL mint address (Token or Token-2022) on Solana.
- **Any other EVM chain** can be added in `config.json` (see [Configuration](#configuration)).
- The server lists everything at `GET /coins`, and the web page shows it under "Supported coins".
- **Not supported:** Dogecoin, XRP, Cardano, Tron, Monero, TON, Bitcoin Lightning, and Bitcoin Ordinals/Runes. Bitcoin Ordinals in particular can be **spent by accident**, because coin selection doesn't know about inscriptions. Don't use a seed that holds them.

## Quick start

Requires Node.js 20+.

```bash
npm install
```

```bash
npm start
```

Open http://127.0.0.1:8787 **in a browser on the same machine**, paste your seed, tick the coins you want, and pick a passphrase (12+ characters). You get:

- **An API key** (`sk_...`), shown once. Save it.
- **Your account 0 address on each coin you picked.** Check they match your existing wallet.

To do setup in the terminal instead (seed input is hidden; it lists the coins and asks which you want):

```bash
npm run setup
```

The seed is encrypted with your passphrase and saved to `data/vault.json`. After a restart the wallet is **locked**. Unlock it from the web page, with `POST /unlock`, or start the server with the passphrase in the environment:

```bash
SEEDTOAPI_PASSPHRASE='your passphrase' npm start
```

### Changing your coins later

Use "Change which coins are enabled" on the web page, or:

```bash
curl -X PUT http://127.0.0.1:8787/v1/chains \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"enabled":["btc","eth","sol","base"],"passphrase":"your passphrase"}'
```

This needs your passphrase, not just the API key, so whoever holds the key can't turn on more coins. The list is stored in the vault and authenticated with the passphrase, so editing the file by hand makes the vault fail to unlock.

## Using the API

Send the key as `Authorization: Bearer sk_...` (or the `X-API-Key` header). Every wallet call takes:

- **`chain`**: which coin/network, e.g. `"bitcoin"`, `"eth"`, `"sol"`, `"base"`. You can leave it out if you only enabled one coin, or if `defaultChain` is set in the config.
- **`amount`**: a decimal string in normal units. `"0.05"` means 0.05 BTC, 0.05 ETH, or 0.05 USDC.
- **`account`**: which account from the seed (default `0`).

```bash
export KEY=sk_...
```

```bash
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:8787/v1/addresses"
```

```bash
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:8787/v1/balance?chain=btc"
```

```bash
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:8787/v1/balance?chain=sol&token=USDC"
```

**Send Bitcoin.** Use `"dryRun": true` first to see the fee without sending. `speed` is `fast`, `normal` (default) or `slow`; or pass `feeRate` in sat/vB:

```bash
curl -X POST http://127.0.0.1:8787/v1/transfer \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"chain":"btc","to":"bc1q...","amount":"0.001","speed":"normal","dryRun":true}'
```

**Send ETH, SOL, or any chain's own coin:**

```bash
curl -X POST http://127.0.0.1:8787/v1/transfer \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"chain":"base","to":"0xRecipient...","amount":"0.01"}'
```

**Send a token**, by symbol or by contract/mint address:

```bash
curl -X POST http://127.0.0.1:8787/v1/transfer \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"chain":"sol","to":"RecipientSolanaAddress...","amount":"25","token":"USDC"}'
```

**Send an NFT** (on Solana, `contract` is the NFT's mint address):

```bash
curl -X POST http://127.0.0.1:8787/v1/nft/transfer \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"chain":"eth","to":"0xRecipient...","contract":"0xNftContract...","tokenId":"1234","standard":"erc721"}'
```

### How each coin behaves

- **Bitcoin / Litecoin:** an "account" is a whole BIP-84 wallet, as in Sparrow or Electrum. The balance and spending cover every address that wallet has used: the server scans receive and change addresses until it finds 20 unused in a row. Change goes to a fresh change address. Transactions signal replace-by-fee. Sends return straight away (`"status": "pending"`). Check progress with `GET /v1/transactions/:txid?chain=btc`. Balances and history come from mempool.space / litecoinspace.org unless you set your own Esplora server.
- **Solana:** token sends create the recipient's token account if it doesn't exist yet. That costs about 0.002 SOL, paid by you. `POST /v1/transactions` takes a base64 transaction built elsewhere (for example by a swap API), signs it, and sends it.
- **EVM chains:** `POST /v1/transactions` sends any contract call (`to`, `data`, `value` in wei). `/v1/sign/typed-data` is EVM only.

### Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/` | Web page for setup, unlock, picking coins and quick tests |
| GET | `/status` | `uninitialized`, `locked` or `unlocked` (no auth) |
| GET | `/coins` | Every supported coin, its `chain` names and built-in tokens (no auth) |
| POST | `/setup` | `{mnemonic, passphrase, chains: ["btc","eth",…], bip39Passphrase?}` → API key. Localhost only, once |
| POST | `/unlock` | `{passphrase}`. Localhost only |
| POST | `/lock` | Forget the decrypted seed until the next unlock |
| GET | `/v1/chains` | The coins you enabled |
| PUT | `/v1/chains` | `{enabled: [...], passphrase}` change which coins are enabled. Localhost only |
| GET | `/v1/addresses?account=0` | Your address on every enabled coin |
| GET | `/v1/accounts?chain=&offset=0&count=5` | Addresses for several accounts on one coin |
| GET | `/v1/balance?chain=&account=&token=` | Coin balance, or token balance if `token` is given |
| POST | `/v1/transfer` | `{chain, account, to, amount, token?, dryRun?, wait?, speed?, feeRate?}` |
| POST | `/v1/nft/transfer` | `{chain, account, to, contract, tokenId, standard: "erc721"\|"erc1155", amount?, dryRun?, wait?}` |
| POST | `/v1/transactions` | EVM: `{chain, to, data, value}` any contract call. Solana: `{chain, transaction}` sign a base64 transaction |
| GET | `/v1/transactions/:hash?chain=` | Status of a transaction |
| POST | `/v1/sign/message` | `{chain, account, message}` EVM (EIP-191) or Solana (ed25519) signature |
| POST | `/v1/sign/typed-data` | `{chain, account, domain, types, message}` EIP-712 signature (EVM) |
| POST | `/v1/api-key/rotate` | `{passphrase}` issues a new key; the old one stops working. Localhost only |

Sends return when the transaction is broadcast (`"status": "pending"`, plus an `explorer` link). On EVM and Solana, pass `"wait": true` to wait for confirmation. Errors come back as `{"error": "..."}`:

- **400**: bad input.
- **401**: bad key or passphrase.
- **403**: coin not enabled, or blocked by policy.
- **422**: the transaction would fail, e.g. insufficient funds.
- **423**: wallet locked.
- **502**: the node/API can't be reached.

## Configuration

Copy `config.example.json` to `config.json` and edit it. Everything is optional.

- **`chains`**: override settings of a built-in network, e.g. its `rpcUrl` (EVM and Solana) or `apiUrl` (Bitcoin/Litecoin Esplora API). You can also add any EVM chain with `{"family": "evm", "chainId": …, "rpcUrl": "…", "symbol": "…", "name": "…"}`. The built-in defaults are free public endpoints, which are rate-limited. For real use, put your own provider here (Alchemy, Infura, QuickNode, Helius, your own node or mempool instance).
- **`defaultChain`**: used when a request leaves out `chain`.
- **`policy.allowedRecipients`**: if set, sends can only go to these addresses. Mix addresses from any coin in one list. Strongly recommended if the API key lives in another app. While this is set, pre-built Solana transactions are refused, because they can't be checked.
- **`policy.maxNativeValuePerTx`**: per-chain cap on the coin itself per transaction, e.g. `{"bitcoin": "0.01", "ethereum": "0.5", "solana": "10"}`.
- **`policy.allowRawTransactions`**: set `false` to turn off `/v1/transactions`.
- **`derivationPath`** on a chain entry: change it if your wallet uses a different path. `{index}` is replaced by the account number.

Environment overrides: `SEEDTOAPI_HOST`, `SEEDTOAPI_PORT`, `SEEDTOAPI_VAULT`, `SEEDTOAPI_DEFAULT_CHAIN`, `SEEDTOAPI_CONFIG`, `SEEDTOAPI_PASSPHRASE`.

## Security

What it does:

- The seed is never stored in plaintext. It is encrypted with AES-256-GCM using a key derived from your passphrase with scrypt (N=2^17). The vault file is created with `0600` permissions.
- The API key is random (256 bits) and only its SHA-256 hash is stored. The hash and your coin choices are bound to the ciphertext, so editing the file to swap in another key or enable more coins breaks decryption.
- The API only works on the coins you picked. Changing that needs the passphrase.
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

The tests:

- Start a local Ganache chain, deploy a test ERC-20 and NFT, and run real transfers through the API.
- Run Bitcoin sends against a mock Esplora API, checking every signature independently.
- Run Solana sends against a mock RPC node that verifies signatures and decodes the instructions.
- Check address derivation against the official BIP-84 and SLIP-10 test vectors.

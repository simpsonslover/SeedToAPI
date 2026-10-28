// Holds the server's wallet state: uninitialized -> locked <-> unlocked.

import {
  sealVault,
  openVault,
  readVault,
  writeVault,
  vaultExists,
  generateApiKey,
  hashApiKey,
  apiKeyMatches,
  MIN_PASSPHRASE_LENGTH,
  WrongPassphraseError,
} from './vault.js';
import { WalletService, ApiError, isValidMnemonic, normalizeMnemonic, resolveChainIds } from './wallet.js';

export class Keeper {
  constructor({ config, kdf } = {}) {
    this.config = config;
    this.kdf = kdf; // tests pass cheaper scrypt params
    this.vault = null;
    this.wallet = null;
    this.failedUnlocks = 0;
  }

  async load() {
    if (vaultExists(this.config.vaultPath)) this.vault = await readVault(this.config.vaultPath);
    return this;
  }

  get state() {
    if (!this.vault) return 'uninitialized';
    return this.wallet ? 'unlocked' : 'locked';
  }

  // Chains picked at setup. Vaults from before chain picking enable every EVM chain.
  get enabledChains() {
    if (!this.vault) return [];
    const picked = this.vault.settings?.enabledChains;
    if (!picked) return Object.keys(this.config.chains).filter((id) => this.config.chains[id].family === 'evm');
    return picked.filter((id) => this.config.chains[id]);
  }

  checkApiKey(candidate) {
    return Boolean(this.vault) && apiKeyMatches(candidate, this.vault.apiKeyHash);
  }

  async setup({ mnemonic, passphrase, bip39Passphrase = '', chains }) {
    if (this.vault) throw new ApiError(409, 'A wallet is already set up. Delete the vault file to start over.');
    if (typeof mnemonic !== 'string' || !isValidMnemonic(mnemonic)) {
      throw new ApiError(400, 'mnemonic is not a valid BIP-39 seed phrase (check spelling and word count)');
    }
    validatePassphrase(passphrase);
    if (typeof bip39Passphrase !== 'string') throw new ApiError(400, 'bip39Passphrase must be a string');
    const enabledChains = resolveChainIds(chains, this.config.chains);

    const apiKey = generateApiKey();
    const secret = { mnemonic: normalizeMnemonic(mnemonic), bip39Passphrase };
    const vault = await sealVault({
      secret,
      passphrase,
      apiKeyHash: hashApiKey(apiKey),
      settings: { enabledChains },
      ...(this.kdf && { kdf: this.kdf }),
    });
    await writeVault(this.config.vaultPath, vault);
    this.vault = vault;
    this.#startWallet(secret);
    return { apiKey, enabledChains, ...this.wallet.addresses({ account: 0 }) };
  }

  async unlock(passphrase) {
    if (!this.vault) throw new ApiError(409, 'No wallet set up yet');
    if (this.wallet) throw new ApiError(409, 'Wallet is already unlocked');
    if (typeof passphrase !== 'string') throw new ApiError(400, 'passphrase is required');
    // Back off after repeated failures (scrypt already makes each guess slow).
    if (this.failedUnlocks > 3) await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (this.failedUnlocks - 3), 30_000)));
    let secret;
    try {
      secret = await openVault(this.vault, passphrase);
    } catch (err) {
      if (err instanceof WrongPassphraseError) {
        this.failedUnlocks++;
        throw new ApiError(401, 'Wrong passphrase');
      }
      throw err;
    }
    this.failedUnlocks = 0;
    this.#startWallet(secret);
  }

  lock() {
    this.wallet?.destroy();
    this.wallet = null;
  }

  async rotateApiKey(passphrase) {
    const apiKey = generateApiKey();
    await this.#reseal(passphrase, { apiKeyHash: hashApiKey(apiKey) });
    return { apiKey };
  }

  // Changing which chains are enabled needs the passphrase, so a leaked API key
  // can't widen what it can reach.
  async setEnabledChains(chains, passphrase) {
    const enabledChains = resolveChainIds(chains, this.config.chains);
    await this.#reseal(passphrase, { settings: { ...(this.vault?.settings || {}), enabledChains } });
    this.wallet?.setEnabledChains(enabledChains);
    return { enabledChains };
  }

  async #reseal(passphrase, changes) {
    if (!this.vault) throw new ApiError(409, 'No wallet set up yet');
    if (typeof passphrase !== 'string') throw new ApiError(400, 'passphrase is required');
    let secret;
    try {
      secret = await openVault(this.vault, passphrase);
    } catch (err) {
      if (err instanceof WrongPassphraseError) throw new ApiError(401, 'Wrong passphrase');
      throw err;
    }
    const { name, N, r, p, keyLen } = this.vault.kdf;
    const vault = await sealVault({
      secret,
      passphrase,
      apiKeyHash: changes.apiKeyHash ?? this.vault.apiKeyHash,
      settings: changes.settings ?? this.vault.settings ?? { enabledChains: this.enabledChains },
      kdf: { name, N, r, p, keyLen },
    });
    await writeVault(this.config.vaultPath, vault);
    this.vault = vault;
  }

  #startWallet(secret) {
    this.wallet = new WalletService({
      mnemonic: secret.mnemonic,
      bip39Passphrase: secret.bip39Passphrase,
      config: this.config,
      enabledChains: this.enabledChains,
    });
  }
}

function validatePassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new ApiError(400, `passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters; it encrypts your seed on disk`);
  }
}

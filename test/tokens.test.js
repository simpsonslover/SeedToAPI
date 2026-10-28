// ERC-20 and NFT transfers against contracts deployed to a local Ganache chain.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ganache from 'ganache';
import solc from 'solc';
import { ContractFactory, JsonRpcProvider, Wallet } from 'ethers';
import { DEFAULT_CONFIG } from '../src/config.js';
import { Keeper } from '../src/keeper.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
const RECIPIENT = Wallet.createRandom().address;
const kdf = { name: 'scrypt', N: 2 ** 10, r: 8, p: 1, keyLen: 32 };

let chain, dir, keeper, token, nft;

function compile() {
  const input = {
    language: 'Solidity',
    sources: { 'Tokens.sol': { content: readFileSync(new URL('./fixtures/Tokens.sol', import.meta.url), 'utf8') } },
    settings: { evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  return out.contracts['Tokens.sol'];
}

before(async () => {
  chain = ganache.server({ logging: { quiet: true }, chain: { chainId: 1337 }, wallet: { mnemonic: MNEMONIC } });
  await chain.listen(0);
  const rpcUrl = `http://127.0.0.1:${chain.address().port}`;
  dir = await mkdtemp(join(tmpdir(), 'seedtoapi-'));
  const config = {
    ...DEFAULT_CONFIG,
    vaultPath: join(dir, 'vault.json'),
    defaultChain: 'local',
    chains: { local: { chainId: 1337, rpcUrl, symbol: 'ETH' } },
  };
  keeper = await new Keeper({ config, kdf }).load();
  await keeper.setup({ mnemonic: MNEMONIC, passphrase: 'a very long passphrase' });

  const deployer = Wallet.fromPhrase(MNEMONIC).connect(new JsonRpcProvider(rpcUrl, 1337, { staticNetwork: true, cacheTimeout: -1 }));
  const { TestToken, TestNFT } = compile();
  token = await new ContractFactory(TestToken.abi, TestToken.evm.bytecode.object, deployer).deploy(deployer.address, 1_000_000_000n);
  await token.waitForDeployment();
  nft = await new ContractFactory(TestNFT.abi, TestNFT.evm.bytecode.object, deployer).deploy(deployer.address);
  await nft.waitForDeployment();
});

after(async () => {
  keeper?.lock();
  await chain?.close();
  await rm(dir, { recursive: true, force: true });
});

test('ERC-20 balance uses token decimals', async () => {
  const res = await keeper.wallet.balance({ token: await token.getAddress() });
  assert.equal(res.asset, 'TST');
  assert.equal(res.decimals, 6);
  assert.equal(res.balance, '1000.0');
});

test('ERC-20 transfer', async () => {
  const res = await keeper.wallet.transfer({ to: RECIPIENT, amount: '12.5', token: await token.getAddress(), wait: true });
  assert.equal(res.status, 'success');
  assert.equal(res.type, 'erc20');
  assert.equal(await token.balanceOf(RECIPIENT), 12_500_000n);
});

test('ERC-20 amount with too many decimals is rejected', async () => {
  await assert.rejects(
    keeper.wallet.transfer({ to: RECIPIENT, amount: '0.0000001', token: await token.getAddress() }),
    { status: 400 },
  );
});

test('NFT transfer', async () => {
  const res = await keeper.wallet.transferNft({ to: RECIPIENT, contract: await nft.getAddress(), tokenId: '1', wait: true });
  assert.equal(res.status, 'success');
  assert.equal(await nft.ownerOf(1), RECIPIENT);
});

test('NFT the wallet does not own fails the dry run', async () => {
  await assert.rejects(
    keeper.wallet.transferNft({ to: RECIPIENT, contract: await nft.getAddress(), tokenId: '1', dryRun: true }),
    { status: 422 },
  );
});

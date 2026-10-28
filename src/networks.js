// Every coin/network SeedToAPI supports out of the box.
//
// Each entry's `family` picks the code that handles it:
//   evm     - Ethereum and compatible chains (ethers)
//   bitcoin - Bitcoin-style UTXO chains, native SegWit, via an Esplora API
//   solana  - Solana (SOL and SPL tokens)
//
// `tokens` are well-known tokens you can refer to by symbol, e.g. "token": "USDC".
// Any other token works by passing its contract / mint address instead.

export const NETWORKS = {
  bitcoin: {
    family: 'bitcoin',
    name: 'Bitcoin',
    symbol: 'BTC',
    decimals: 8,
    coinType: 0,
    params: { bech32: 'bc', pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 },
    apiUrl: 'https://mempool.space/api',
    explorer: 'https://mempool.space/tx/',
  },
  litecoin: {
    family: 'bitcoin',
    name: 'Litecoin',
    symbol: 'LTC',
    decimals: 8,
    coinType: 2,
    params: { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 },
    apiUrl: 'https://litecoinspace.org/api',
    explorer: 'https://litecoinspace.org/tx/',
  },
  ethereum: {
    family: 'evm',
    name: 'Ethereum',
    symbol: 'ETH',
    decimals: 18,
    chainId: 1,
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    explorer: 'https://etherscan.io/tx/',
    tokens: {
      USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    },
  },
  solana: {
    family: 'solana',
    name: 'Solana',
    symbol: 'SOL',
    decimals: 9,
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    explorer: 'https://solscan.io/tx/',
    tokens: {
      USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    },
  },
  base: {
    family: 'evm',
    name: 'Base',
    symbol: 'ETH',
    decimals: 18,
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    explorer: 'https://basescan.org/tx/',
    tokens: {
      USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      WETH: '0x4200000000000000000000000000000000000006',
    },
  },
  arbitrum: {
    family: 'evm',
    name: 'Arbitrum One',
    symbol: 'ETH',
    decimals: 18,
    chainId: 42161,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    explorer: 'https://arbiscan.io/tx/',
    tokens: { USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  },
  optimism: {
    family: 'evm',
    name: 'OP Mainnet',
    symbol: 'ETH',
    decimals: 18,
    chainId: 10,
    rpcUrl: 'https://mainnet.optimism.io',
    explorer: 'https://optimistic.etherscan.io/tx/',
    tokens: {
      USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      WETH: '0x4200000000000000000000000000000000000006',
    },
  },
  polygon: {
    family: 'evm',
    name: 'Polygon',
    symbol: 'POL',
    decimals: 18,
    chainId: 137,
    rpcUrl: 'https://polygon-bor-rpc.publicnode.com',
    explorer: 'https://polygonscan.com/tx/',
    tokens: { USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  },
  bsc: {
    family: 'evm',
    name: 'BNB Smart Chain',
    symbol: 'BNB',
    decimals: 18,
    chainId: 56,
    rpcUrl: 'https://bsc-rpc.publicnode.com',
    explorer: 'https://bscscan.com/tx/',
    tokens: { USDT: '0x55d398326f99059fF775485246999027B3197955' },
  },
  avalanche: {
    family: 'evm',
    name: 'Avalanche C-Chain',
    symbol: 'AVAX',
    decimals: 18,
    chainId: 43114,
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    explorer: 'https://snowtrace.io/tx/',
    tokens: {
      USDC: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      USDT: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
    },
  },

  // Testnets: free coins from faucets, for trying things out.
  'bitcoin-testnet': {
    family: 'bitcoin',
    name: 'Bitcoin Testnet4',
    symbol: 'tBTC',
    decimals: 8,
    coinType: 1,
    testnet: true,
    params: { bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef },
    apiUrl: 'https://mempool.space/testnet4/api',
    explorer: 'https://mempool.space/testnet4/tx/',
  },
  sepolia: {
    family: 'evm',
    name: 'Ethereum Sepolia',
    symbol: 'ETH',
    decimals: 18,
    chainId: 11155111,
    testnet: true,
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.etherscan.io/tx/',
    tokens: { USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
  },
  'base-sepolia': {
    family: 'evm',
    name: 'Base Sepolia',
    symbol: 'ETH',
    decimals: 18,
    chainId: 84532,
    testnet: true,
    rpcUrl: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org/tx/',
    tokens: { USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
  },
  'solana-devnet': {
    family: 'solana',
    name: 'Solana Devnet',
    symbol: 'SOL',
    decimals: 9,
    testnet: true,
    rpcUrl: 'https://api.devnet.solana.com',
    explorer: 'https://solscan.io/tx/',
  },
};

// Short names people may type instead of the network id.
export const ALIASES = {
  btc: 'bitcoin',
  ltc: 'litecoin',
  eth: 'ethereum',
  sol: 'solana',
  arb: 'arbitrum',
  op: 'optimism',
  pol: 'polygon',
  matic: 'polygon',
  bnb: 'bsc',
  avax: 'avalanche',
  tbtc: 'bitcoin-testnet',
  testnet4: 'bitcoin-testnet',
};

export const FAMILIES = ['evm', 'bitcoin', 'solana'];

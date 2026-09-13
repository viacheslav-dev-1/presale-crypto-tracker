import type { Chain } from "../domain/token-candidate.js";

export type EvmAddress = `0x${string}`;

export interface DexFactoryConfig {
  name: string;
  address: EvmAddress;
  type: "v2" | "v3" | "v4";
  swapFeeRate?: number;
}

export interface EvmChainConfig {
  id: number;
  key: Extract<Chain, "bsc" | "base" | "robinhood">;
  name: string;
  httpRpcUrl: string;
  wsRpcUrl?: string;
  nativeSymbol: string;
  quoteTokens: readonly EvmAddress[];
  usdStableTokens: readonly EvmAddress[];
  wrappedNativeToken?: EvmAddress;
  dexFactories: readonly DexFactoryConfig[];
  pollingIntervalMs: number;
}

// Verified against BNB Chain and PancakeSwap deployment documentation on 2026-09-13.
export const BSC_MAINNET_DEFAULTS = {
  chainId: 56,
  wbnb: "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  usdt: "0x55d398326f99059fF775485246999027B3197955",
  usdc: "0x8AC76a51cc950d9822D68b83Fe1Ad97B32Cd580d",
  pancakeSwapV2Factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
  pancakeSwapV3Factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
} as const satisfies Record<string, number | EvmAddress>;

// Verified against Base and Uniswap deployment documentation on 2026-09-13.
export const BASE_MAINNET_DEFAULTS = {
  chainId: 8453,
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  uniswapV2Factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
  uniswapV3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  uniswapV4PoolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
} as const satisfies Record<string, number | EvmAddress>;

// Verified against Robinhood Chain and Uniswap deployment documentation on 2026-09-11.
export const ROBINHOOD_MAINNET_DEFAULTS = {
  chainId: 4663,
  rpcHttp: "https://rpc.mainnet.chain.robinhood.com",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  uniswapV2Factory: "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f",
  uniswapV3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
  uniswapV4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
} as const satisfies Record<string, number | EvmAddress | string>;

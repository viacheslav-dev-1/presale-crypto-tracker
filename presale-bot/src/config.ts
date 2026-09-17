import "dotenv/config";
import { z } from "zod";
import type { Chain } from "./domain/token-candidate.js";
import { VERIFIED_PUMP_PROGRAM_ID } from "./config/programs.js";
import {
  BASE_MAINNET_DEFAULTS,
  BSC_MAINNET_DEFAULTS,
  ROBINHOOD_MAINNET_DEFAULTS,
  type EvmAddress,
  type EvmChainConfig,
} from "./config/evm.js";

const splitCommaSeparated = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const evmAddressList = (defaults: readonly EvmAddress[]) => z
  .string()
  .default(defaults.join(","))
  .transform(splitCommaSeparated)
  .pipe(z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid EVM address")).min(1))
  .transform((addresses) => addresses as EvmAddress[]);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
    TELEGRAM_ADMIN_IDS: z
      .string()
      .default("")
      .transform(splitCommaSeparated)
      .pipe(z.array(z.string().regex(/^\d+$/, "Telegram admin IDs must be positive integers")))
      .transform((ids) => ids.map(Number))
      .refine((ids) => ids.every((id) => Number.isSafeInteger(id) && id > 0), "Telegram admin IDs must be positive safe integers"),
    TELEGRAM_AUDIENCE_FILE: z.string().min(1).default(".data/telegram-audience.json"),
    TELEGRAM_DELIVERY_HISTORY_FILE: z.string().min(1).default(".data/telegram-delivery-history.json"),
    CREATOR_HISTORY_FILE: z.string().min(1).default(".data/creator-history.json"),
    CREATOR_MEANINGFUL_LIQUIDITY_USD: z.coerce.number().finite().min(0).default(25_000),
    CRYPTORANK_API_KEY: z.string().min(1).optional().or(z.literal("")),
    TOKEN_UNLOCK_PROVIDER: z.enum(["coinmarketcap", "cryptorank"]).default("coinmarketcap"),
    DEFAULT_DELIVERY_MODE: z.enum(["IMMEDIATE", "ONE_MINUTE_DIGEST"]).default("ONE_MINUTE_DIGEST"),
    IMMEDIATE_MESSAGE_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(2_000),
    MAX_CANDIDATE_AGE_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(600_000),
    DEFAULT_MIN_MARKET_CAP_USD: z.coerce.number().finite().min(0).default(0),
    DEFAULT_MAX_MARKET_CAP_USD: z.coerce.number().finite().min(0).default(10_000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    SOLANA_RPC_HTTP: z.string().url().optional().or(z.literal("")),
    SOLANA_RPC_WS: z.string().url().optional().or(z.literal("")),
    SOLANA_COMMITMENT: z.enum(["processed", "confirmed", "finalized"]).default("processed"),
    HELIUS_API_KEY: z.string().min(1).optional().or(z.literal("")),
    PUMPFUN_PROGRAM_ID: z.string().default(VERIFIED_PUMP_PROGRAM_ID),
    BSC_CHAIN_ID: z.coerce.number().int().positive().default(BSC_MAINNET_DEFAULTS.chainId),
    BSC_RPC_HTTP: z.string().url().optional().or(z.literal("")),
    BSC_RPC_WS: z.string().url().optional().or(z.literal("")),
    BSC_QUOTE_TOKENS: evmAddressList([
      BSC_MAINNET_DEFAULTS.wbnb,
      BSC_MAINNET_DEFAULTS.usdt,
      BSC_MAINNET_DEFAULTS.usdc,
    ]),
    BSC_USD_STABLE_TOKENS: evmAddressList([BSC_MAINNET_DEFAULTS.usdt, BSC_MAINNET_DEFAULTS.usdc]),
    BSC_WRAPPED_NATIVE_TOKEN: z.string().regex(/^0x[0-9a-fA-F]{40}$/).default(BSC_MAINNET_DEFAULTS.wbnb),
    BSC_V2_FACTORIES: evmAddressList([BSC_MAINNET_DEFAULTS.pancakeSwapV2Factory]),
    BSC_V3_FACTORIES: evmAddressList([BSC_MAINNET_DEFAULTS.pancakeSwapV3Factory]),
    BSC_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
    BASE_CHAIN_ID: z.coerce.number().int().positive().default(BASE_MAINNET_DEFAULTS.chainId),
    BASE_RPC_HTTP: z.string().url().optional().or(z.literal("")),
    BASE_RPC_WS: z.string().url().optional().or(z.literal("")),
    BASE_QUOTE_TOKENS: evmAddressList([BASE_MAINNET_DEFAULTS.weth, BASE_MAINNET_DEFAULTS.usdc]),
    BASE_USD_STABLE_TOKENS: evmAddressList([BASE_MAINNET_DEFAULTS.usdc]),
    BASE_WRAPPED_NATIVE_TOKEN: z.string().regex(/^0x[0-9a-fA-F]{40}$/).default(BASE_MAINNET_DEFAULTS.weth),
    BASE_V2_FACTORIES: evmAddressList([BASE_MAINNET_DEFAULTS.uniswapV2Factory]),
    BASE_V3_FACTORIES: evmAddressList([BASE_MAINNET_DEFAULTS.uniswapV3Factory]),
    BASE_V4_POOL_MANAGERS: evmAddressList([BASE_MAINNET_DEFAULTS.uniswapV4PoolManager]),
    BASE_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
    ROBINHOOD_CHAIN_ID: z.coerce.number().int().positive().default(ROBINHOOD_MAINNET_DEFAULTS.chainId),
    ROBINHOOD_RPC_HTTP: z.string().url().default(ROBINHOOD_MAINNET_DEFAULTS.rpcHttp),
    ROBINHOOD_RPC_WS: z.string().url().optional().or(z.literal("")),
    ROBINHOOD_QUOTE_TOKENS: evmAddressList([ROBINHOOD_MAINNET_DEFAULTS.weth, ROBINHOOD_MAINNET_DEFAULTS.usdg]),
    ROBINHOOD_USD_STABLE_TOKENS: evmAddressList([ROBINHOOD_MAINNET_DEFAULTS.usdg]),
    ROBINHOOD_WRAPPED_NATIVE_TOKEN: z.string().regex(/^0x[0-9a-fA-F]{40}$/).default(ROBINHOOD_MAINNET_DEFAULTS.weth),
    ROBINHOOD_V2_FACTORIES: evmAddressList([ROBINHOOD_MAINNET_DEFAULTS.uniswapV2Factory]),
    ROBINHOOD_V3_FACTORIES: evmAddressList([ROBINHOOD_MAINNET_DEFAULTS.uniswapV3Factory]),
    ROBINHOOD_V4_POOL_MANAGERS: evmAddressList([ROBINHOOD_MAINNET_DEFAULTS.uniswapV4PoolManager]),
    ROBINHOOD_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
  })
  .superRefine((env, ctx) => {
    if (env.DEFAULT_MIN_MARKET_CAP_USD > env.DEFAULT_MAX_MARKET_CAP_USD) {
      ctx.addIssue({
        code: "custom",
        path: ["DEFAULT_MAX_MARKET_CAP_USD"],
        message: "Default maximum market cap must be greater than or equal to the minimum",
      });
    }
  });

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  telegramToken: string;
  telegramAdminIds: ReadonlySet<number>;
  telegramAudienceFile: string;
  telegramDeliveryHistoryFile: string;
  creatorHistoryFile: string;
  creatorMeaningfulLiquidityUsd: number;
  cryptoRankApiKey?: string;
  tokenUnlockProvider?: "coinmarketcap" | "cryptorank";
  defaultDeliveryMode: "IMMEDIATE" | "ONE_MINUTE_DIGEST";
  immediateMessageIntervalMs: number;
  maxCandidateAgeMs: number;
  defaultMinimumMarketCapUsd: number;
  defaultMaximumMarketCapUsd: number;
  enabledChains: readonly Chain[];
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  solana: {
    rpcHttp?: string;
    rpcWs?: string;
    commitment: "processed" | "confirmed" | "finalized";
    pumpProgramId: string;
    heliusApiKey?: string;
  };
  bsc?: EvmChainConfig;
  base?: EvmChainConfig;
  robinhood: EvmChainConfig;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = EnvSchema.parse(environment);
  const solanaRpcHttp = env.SOLANA_RPC_HTTP || undefined;
  const solanaRpcWs = env.SOLANA_RPC_WS || undefined;
  const bscRpcHttp = env.BSC_RPC_HTTP || undefined;
  const bscRpcWs = env.BSC_RPC_WS || undefined;
  const baseRpcHttp = env.BASE_RPC_HTTP || undefined;
  const baseRpcWs = env.BASE_RPC_WS || undefined;
  const robinhoodRpcWs = env.ROBINHOOD_RPC_WS || undefined;
  return {
    nodeEnv: env.NODE_ENV,
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    telegramAdminIds: new Set(env.TELEGRAM_ADMIN_IDS),
    telegramAudienceFile: env.TELEGRAM_AUDIENCE_FILE,
    telegramDeliveryHistoryFile: env.TELEGRAM_DELIVERY_HISTORY_FILE,
    creatorHistoryFile: env.CREATOR_HISTORY_FILE,
    creatorMeaningfulLiquidityUsd: env.CREATOR_MEANINGFUL_LIQUIDITY_USD,
    ...(env.CRYPTORANK_API_KEY ? { cryptoRankApiKey: env.CRYPTORANK_API_KEY } : {}),
    tokenUnlockProvider: env.TOKEN_UNLOCK_PROVIDER,
    defaultDeliveryMode: env.DEFAULT_DELIVERY_MODE,
    immediateMessageIntervalMs: env.IMMEDIATE_MESSAGE_INTERVAL_MS,
    maxCandidateAgeMs: env.MAX_CANDIDATE_AGE_MS,
    defaultMinimumMarketCapUsd: env.DEFAULT_MIN_MARKET_CAP_USD,
    defaultMaximumMarketCapUsd: env.DEFAULT_MAX_MARKET_CAP_USD,
    enabledChains: ["robinhood"],
    logLevel: env.LOG_LEVEL,
    solana: {
      ...(solanaRpcHttp ? { rpcHttp: solanaRpcHttp } : {}),
      ...(solanaRpcWs ? { rpcWs: solanaRpcWs } : {}),
      commitment: env.SOLANA_COMMITMENT,
      pumpProgramId: env.PUMPFUN_PROGRAM_ID,
      ...(env.HELIUS_API_KEY ? { heliusApiKey: env.HELIUS_API_KEY } : {}),
    },
    ...(bscRpcHttp ? {
      bsc: {
        id: env.BSC_CHAIN_ID,
        key: "bsc",
        name: "BSC",
        httpRpcUrl: bscRpcHttp,
        ...(bscRpcWs ? { wsRpcUrl: bscRpcWs } : {}),
        nativeSymbol: "BNB",
        quoteTokens: env.BSC_QUOTE_TOKENS,
        usdStableTokens: env.BSC_USD_STABLE_TOKENS,
        wrappedNativeToken: env.BSC_WRAPPED_NATIVE_TOKEN as `0x${string}`,
        dexFactories: [
          ...env.BSC_V2_FACTORIES.map((address, index) => ({
            name: `PancakeSwap V2${index === 0 ? "" : ` ${index + 1}`}`,
            address,
            type: "v2" as const,
            swapFeeRate: 0.0025,
          })),
          ...env.BSC_V3_FACTORIES.map((address, index) => ({
            name: `PancakeSwap V3${index === 0 ? "" : ` ${index + 1}`}`,
            address,
            type: "v3" as const,
          })),
        ],
        pollingIntervalMs: env.BSC_POLL_INTERVAL_MS,
      },
    } : {}),
    ...(baseRpcHttp ? {
      base: {
        id: env.BASE_CHAIN_ID,
        key: "base",
        name: "Base",
        httpRpcUrl: baseRpcHttp,
        ...(baseRpcWs ? { wsRpcUrl: baseRpcWs } : {}),
        nativeSymbol: "ETH",
        quoteTokens: env.BASE_QUOTE_TOKENS,
        usdStableTokens: env.BASE_USD_STABLE_TOKENS,
        wrappedNativeToken: env.BASE_WRAPPED_NATIVE_TOKEN as `0x${string}`,
        dexFactories: [
          ...env.BASE_V2_FACTORIES.map((address, index) => ({
            name: `Uniswap V2${index === 0 ? "" : ` ${index + 1}`}`,
            address,
            type: "v2" as const,
            swapFeeRate: 0.003,
          })),
          ...env.BASE_V3_FACTORIES.map((address, index) => ({
            name: `Uniswap V3${index === 0 ? "" : ` ${index + 1}`}`,
            address,
            type: "v3" as const,
          })),
          ...env.BASE_V4_POOL_MANAGERS.map((address, index) => ({
            name: `Uniswap V4 PoolManager${index === 0 ? "" : ` ${index + 1}`}`,
            address,
            type: "v4" as const,
          })),
        ],
        pollingIntervalMs: env.BASE_POLL_INTERVAL_MS,
      },
    } : {}),
    robinhood: {
      id: env.ROBINHOOD_CHAIN_ID,
      key: "robinhood",
      name: "Robinhood Chain",
      httpRpcUrl: env.ROBINHOOD_RPC_HTTP,
      ...(robinhoodRpcWs ? { wsRpcUrl: robinhoodRpcWs } : {}),
      nativeSymbol: "ETH",
      quoteTokens: env.ROBINHOOD_QUOTE_TOKENS,
      usdStableTokens: env.ROBINHOOD_USD_STABLE_TOKENS,
      wrappedNativeToken: env.ROBINHOOD_WRAPPED_NATIVE_TOKEN as `0x${string}`,
      dexFactories: [
        ...env.ROBINHOOD_V2_FACTORIES.map((address, index) => ({
          name: `Uniswap V2${index === 0 ? "" : ` ${index + 1}`}`,
          address,
          type: "v2" as const,
        })),
        ...env.ROBINHOOD_V3_FACTORIES.map((address, index) => ({
          name: `Uniswap V3${index === 0 ? "" : ` ${index + 1}`}`,
          address,
          type: "v3" as const,
        })),
        ...env.ROBINHOOD_V4_POOL_MANAGERS.map((address, index) => ({
          name: `Uniswap V4 PoolManager${index === 0 ? "" : ` ${index + 1}`}`,
          address,
          type: "v4" as const,
        })),
      ],
      pollingIntervalMs: env.ROBINHOOD_POLL_INTERVAL_MS,
    },
  };
}

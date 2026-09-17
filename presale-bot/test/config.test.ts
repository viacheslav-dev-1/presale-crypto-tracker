import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const validEnvironment = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_ADMIN_IDS: "123,456",
};

describe("loadConfig", () => {
  it("loads safe defaults and parses admin IDs", () => {
    const config = loadConfig(validEnvironment);
    expect(config.defaultDeliveryMode).toBe("ONE_MINUTE_DIGEST");
    expect(config.immediateMessageIntervalMs).toBe(2_000);
    expect(config.maxCandidateAgeMs).toBe(600_000);
    expect(config.creatorHistoryFile).toBe(".data/creator-history.json");
    expect(config.telegramDeliveryHistoryFile).toBe(".data/telegram-delivery-history.json");
    expect(config.creatorMeaningfulLiquidityUsd).toBe(25_000);
    expect(config.tokenUnlockProvider).toBe("coinmarketcap");
    expect(config.defaultMinimumMarketCapUsd).toBe(0);
    expect(config.defaultMaximumMarketCapUsd).toBe(10_000);
    expect([...config.telegramAdminIds]).toEqual([123, 456]);
    expect(config.enabledChains).toEqual(["robinhood"]);
    expect(config.bsc).toBeUndefined();
    expect(config.base).toBeUndefined();
    expect(config.robinhood).toMatchObject({
      id: 4663,
      key: "robinhood",
      httpRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    });
    expect(config.robinhood.dexFactories.map((factory) => factory.type)).toEqual(["v2", "v3", "v4"]);
    expect(config.solana.heliusApiKey).toBeUndefined();
  });

  it("configures Uniswap V2, V3, and V4 discovery when a Base RPC is supplied", () => {
    const config = loadConfig({
      ...validEnvironment,
      BASE_RPC_HTTP: "https://base.example.test",
      BASE_RPC_WS: "wss://base.example.test/ws",
    });
    expect(config.base).toMatchObject({
      id: 8453,
      key: "base",
      name: "Base",
      httpRpcUrl: "https://base.example.test",
      wsRpcUrl: "wss://base.example.test/ws",
      nativeSymbol: "ETH",
      wrappedNativeToken: "0x4200000000000000000000000000000000000006",
      quoteTokens: [
        "0x4200000000000000000000000000000000000006",
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      ],
    });
    expect(config.base?.dexFactories).toEqual([
      expect.objectContaining({
        name: "Uniswap V2",
        address: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
        type: "v2",
        swapFeeRate: 0.003,
      }),
      expect.objectContaining({
        name: "Uniswap V3",
        address: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
        type: "v3",
      }),
      expect.objectContaining({
        name: "Uniswap V4 PoolManager",
        address: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
        type: "v4",
      }),
    ]);
  });

  it("configures PancakeSwap V2 and V3 discovery when a BSC RPC is supplied", () => {
    const config = loadConfig({
      ...validEnvironment,
      BSC_RPC_HTTP: "https://bsc.example.test",
      BSC_RPC_WS: "wss://bsc.example.test/ws",
    });
    expect(config.bsc).toMatchObject({
      id: 56,
      key: "bsc",
      name: "BSC",
      httpRpcUrl: "https://bsc.example.test",
      wsRpcUrl: "wss://bsc.example.test/ws",
      nativeSymbol: "BNB",
      wrappedNativeToken: "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    });
    expect(config.bsc?.dexFactories).toEqual([
      expect.objectContaining({
        name: "PancakeSwap V2",
        address: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
        type: "v2",
        swapFeeRate: 0.0025,
      }),
      expect.objectContaining({
        name: "PancakeSwap V3",
        address: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
        type: "v3",
      }),
    ]);
  });

  it("loads an optional Helius key for indexed Solana holder data", () => {
    const config = loadConfig({ ...validEnvironment, HELIUS_API_KEY: "helius-test-key" });
    expect(config.solana.heliusApiKey).toBe("helius-test-key");
  });

  it("loads an optional CryptoRank key for token unlock data", () => {
    const config = loadConfig({ ...validEnvironment, CRYPTORANK_API_KEY: "cryptorank-test-key" });
    expect(config.cryptoRankApiKey).toBe("cryptorank-test-key");
  });

  it("rejects malformed administrator IDs", () => {
    expect(() => loadConfig({ ...validEnvironment, TELEGRAM_ADMIN_IDS: "123,not-an-id" })).toThrow();
    expect(() => loadConfig({ ...validEnvironment, TELEGRAM_ADMIN_IDS: "0" })).toThrow();
  });

  it("allows public mode without administrator IDs", () => {
    const config = loadConfig({ TELEGRAM_BOT_TOKEN: "test-token" });
    expect(config.telegramAdminIds.size).toBe(0);
  });

  it("rejects an inverted default market-cap range", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      DEFAULT_MIN_MARKET_CAP_USD: "20000",
      DEFAULT_MAX_MARKET_CAP_USD: "10000",
    })).toThrow(/maximum market cap/i);
  });
});

import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { EvmChainConfig } from "../src/config/evm.js";
import { EvmDexDetector, type EvmDetectorClient } from "../src/chains/evm/detector.js";
import { createEventBus } from "../src/events/event-bus.js";

const quote = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
const config: EvmChainConfig = {
  id: 4663,
  key: "robinhood",
  name: "Robinhood Chain",
  httpRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  nativeSymbol: "ETH",
  quoteTokens: [quote],
  usdStableTokens: [quote],
  wrappedNativeToken: quote,
  dexFactories: [
    { name: "Uniswap V2", address: "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f", type: "v2" },
    { name: "Uniswap V3", address: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa", type: "v3" },
    { name: "Uniswap V4 PoolManager", address: "0x8366a39cc670b4001a1121b8f6a443a643e40951", type: "v4" },
  ],
  pollingIntervalMs: 1_000,
};

describe("generic EVM DEX detector", () => {
  it("normalizes a PancakeSwap BSC pair with BNB-denominated valuation", async () => {
    const bscQuote = "0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" as const;
    const bscConfig: EvmChainConfig = {
      id: 56,
      key: "bsc",
      name: "BSC",
      httpRpcUrl: "https://bsc.example.test",
      nativeSymbol: "BNB",
      quoteTokens: [bscQuote],
      usdStableTokens: [],
      wrappedNativeToken: bscQuote,
      dexFactories: [{
        name: "PancakeSwap V2",
        address: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
        type: "v2",
        swapFeeRate: 0.0025,
      }],
      pollingIntervalMs: 1_000,
    };
    let watcher: Parameters<EvmDetectorClient["watchContractEvent"]>[0] | undefined;
    const client: EvmDetectorClient = {
      getChainId: vi.fn(async () => 56),
      watchContractEvent: vi.fn((parameters) => {
        watcher = parameters;
        return vi.fn();
      }),
      readContract: vi.fn(async ({ address, functionName }) => {
        if (functionName === "name") return "BSC Token";
        if (functionName === "symbol") return "BSCT";
        if (functionName === "decimals") return 18;
        if (functionName === "totalSupply") return 1_000_000n * 10n ** 18n;
        if (functionName === "balanceOf") return 0n;
        if (functionName === "getReserves") {
          return address === "0x2222222222222222222222222222222222222222"
            ? [10n * 10n ** 18n, 100_000n * 10n ** 18n, 0]
            : undefined;
        }
        return undefined;
      }),
      getBlock: vi.fn(async () => ({ timestamp: 1_700_000_000n })),
      getTransaction: vi.fn(async () => ({ from: "0x6666666666666666666666666666666666666666" as const })),
    };
    const eventBus = createEventBus();
    const received = vi.fn();
    eventBus.on("PoolCreated", received);
    const detector = new EvmDexDetector({
      config: bscConfig,
      client,
      eventBus,
      logger: pino({ level: "silent" }),
      nativeUsdPrice: { currentPrice: vi.fn(async () => 600) },
    });

    await detector.start();
    watcher?.onLogs([{
      args: {
        token0: bscQuote,
        token1: "0x1111111111111111111111111111111111111111",
        pair: "0x2222222222222222222222222222222222222222",
      },
      blockNumber: 12n,
      transactionHash: `0x${"f".repeat(64)}`,
      logIndex: 1,
    }]);

    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
    const candidate = received.mock.calls[0]?.[0].candidate;
    expect(candidate).toMatchObject({
      chain: "bsc",
      source: "dex-pool",
      name: "BSC Token",
      symbol: "BSCT",
      address: "0x1111111111111111111111111111111111111111",
      poolAddress: "0x2222222222222222222222222222222222222222",
      liquidityUsd: 12_000,
      metadata: expect.objectContaining({ factoryName: "PancakeSwap V2", factoryType: "v2" }),
    });
    expect(candidate.quoteToken.toLowerCase()).toBe(bscQuote.toLowerCase());
    expect(candidate.priceUsd).toBeCloseTo(0.06);
    expect(candidate.marketCapUsd).toBeCloseTo(60_000);
    expect(candidate.discoveredAt).toEqual(new Date(1_700_000_000_000));
    expect(candidate.liquidityAnalysis.warnings[0]).toContain("0.25% V2 fee");
    await detector.stop();
  });

  it("normalizes Robinhood Uniswap V2, V3, and V4 events and deduplicates logs", async () => {
    const watchers: Array<Parameters<EvmDetectorClient["watchContractEvent"]>[0]> = [];
    const client: EvmDetectorClient = {
      getChainId: vi.fn(async () => 4663),
      watchContractEvent: vi.fn((parameters) => {
        watchers.push(parameters);
        return vi.fn();
      }),
      readContract: vi.fn(async ({ functionName }) => {
        if (functionName === "name") return "Robin Token";
        if (functionName === "symbol") return "RBN";
        if (functionName === "decimals") return 18;
        if (functionName === "totalSupply") return 1_000_000n * 10n ** 18n;
        if (functionName === "balanceOf") return 100_000n * 10n ** 18n;
        if (functionName === "getReserves") return [1_000_000n * 10n ** 18n, 1_000_000n * 10n ** 18n, 0];
        if (functionName === "slot0") return [2n ** 96n, 0, 0, 0, 0, 0, true];
        return undefined;
      }),
      getTransaction: vi.fn(async () => ({ from: "0x6666666666666666666666666666666666666666" as const })),
    };
    const eventBus = createEventBus();
    const received: Array<{
      address: string;
      poolAddress?: string;
      factoryType?: unknown;
      marketCapUsd?: number;
      liquidityUsd?: number;
      liquidityAnalysis?: unknown;
      factoryName?: unknown;
      creator?: string;
    }> = [];
    eventBus.on("PoolCreated", ({ candidate }) => {
      received.push({
        address: candidate.address,
        ...(candidate.poolAddress ? { poolAddress: candidate.poolAddress } : {}),
        factoryType: candidate.metadata?.factoryType,
        ...(candidate.marketCapUsd !== undefined ? { marketCapUsd: candidate.marketCapUsd } : {}),
        ...(candidate.liquidityUsd !== undefined ? { liquidityUsd: candidate.liquidityUsd } : {}),
        ...(candidate.liquidityAnalysis ? { liquidityAnalysis: candidate.liquidityAnalysis } : {}),
        factoryName: candidate.metadata?.factoryName,
        ...(candidate.creator ? { creator: candidate.creator } : {}),
      });
    });
    const detector = new EvmDexDetector({ config, client, eventBus, logger: pino({ level: "silent" }) });
    await detector.start();

    const v2 = watchers.find((watcher) => watcher.eventName === "PairCreated");
    const v3 = watchers.find((watcher) => watcher.eventName === "PoolCreated");
    const v4 = watchers.find((watcher) => watcher.eventName === "Initialize");
    const firstLog = {
      args: {
        token0: quote,
        token1: "0x1111111111111111111111111111111111111111" as const,
        pair: "0x2222222222222222222222222222222222222222" as const,
      },
      transactionHash: `0x${"a".repeat(64)}` as const,
      logIndex: 1,
    };
    v2?.onLogs([firstLog]);
    v2?.onLogs([firstLog]);
    v3?.onLogs([{
      args: {
        token0: "0x3333333333333333333333333333333333333333",
        token1: quote,
        pool: "0x4444444444444444444444444444444444444444",
        fee: 3_000,
        tickSpacing: 60,
        sqrtPriceX96: 2n ** 96n,
      },
      transactionHash: `0x${"b".repeat(64)}` as const,
      logIndex: 2,
    }]);
    v4?.onLogs([{
      args: {
        id: `0x${"c".repeat(64)}`,
        currency0: quote,
        currency1: "0x5555555555555555555555555555555555555555",
        fee: 3_000,
        tickSpacing: 60,
        sqrtPriceX96: 2n ** 96n,
      },
      transactionHash: `0x${"d".repeat(64)}` as const,
      logIndex: 3,
    }]);

    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received).toEqual(expect.arrayContaining([
      expect.objectContaining({
        address: "0x1111111111111111111111111111111111111111",
        factoryType: "v2",
        creator: "0x6666666666666666666666666666666666666666",
      }),
      expect.objectContaining({ address: "0x3333333333333333333333333333333333333333", factoryType: "v3" }),
      expect.objectContaining({
        address: "0x5555555555555555555555555555555555555555",
        poolAddress: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
        factoryType: "v4",
      }),
    ]));
    expect(detector.status()).toMatchObject({ running: true, subscriptions: 3 });
    received.forEach((candidate) => expect(candidate.marketCapUsd).toBeCloseTo(1_000_000));
    expect(received.find((candidate) => candidate.factoryType === "v2")).toMatchObject({
      liquidityUsd: 2_000_000,
      liquidityAnalysis: {
        venueType: "V2_AMM",
        quoteReserve: 1_000_000,
        controlStatus: "UNVERIFIED",
        priceImpactEstimates: expect.arrayContaining([expect.objectContaining({ tradeUsd: 50 })]),
      },
    });
    expect(received.find((candidate) => candidate.factoryType === "v3")?.liquidityAnalysis).toMatchObject({
      venueType: "CONCENTRATED_LIQUIDITY",
    });
    expect(received.map((candidate) => candidate.factoryName)).toEqual(expect.arrayContaining([
      "Uniswap V2",
      "Uniswap V3",
      "Uniswap V4 PoolManager",
    ]));
    await detector.stop();
    expect(detector.status().running).toBe(false);
  });

  it("rejects an RPC connected to the wrong chain", async () => {
    const client = {
      getChainId: vi.fn(async () => 1),
      watchContractEvent: vi.fn(),
      readContract: vi.fn(),
    } as unknown as EvmDetectorClient;
    const detector = new EvmDexDetector({
      config,
      client,
      eventBus: createEventBus(),
      logger: pino({ level: "silent" }),
    });
    await expect(detector.start()).rejects.toThrow(/does not match configured 4663/);
  });

  it("does not emit pool tokens with invalid ERC-20 metadata", async () => {
    const watchers: Array<Parameters<EvmDetectorClient["watchContractEvent"]>[0]> = [];
    const client: EvmDetectorClient = {
      getChainId: vi.fn(async () => 4663),
      watchContractEvent: vi.fn((parameters) => {
        watchers.push(parameters);
        return vi.fn();
      }),
      readContract: vi.fn(async () => undefined),
    };
    const eventBus = createEventBus();
    const received = vi.fn();
    eventBus.on("PoolCreated", received);
    const detector = new EvmDexDetector({ config, client, eventBus, logger: pino({ level: "silent" }) });
    await detector.start();

    watchers.find((watcher) => watcher.eventName === "PairCreated")?.onLogs([{
      args: {
        token0: quote,
        token1: "0x1111111111111111111111111111111111111111",
        pair: "0x2222222222222222222222222222222222222222",
      },
      transactionHash: `0x${"e".repeat(64)}`,
      logIndex: 1,
    }]);
    await vi.waitFor(() => expect(client.readContract).toHaveBeenCalled());

    expect(received).not.toHaveBeenCalled();
    await detector.stop();
  });
});

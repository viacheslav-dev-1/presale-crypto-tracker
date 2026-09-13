import { PublicKey, type Connection } from "@solana/web3.js";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { PumpFunDetector } from "../src/chains/solana/pumpfun/detector.js";
import type { TokenCandidate } from "../src/domain/token-candidate.js";
import { createEventBus } from "../src/events/event-bus.js";
import { pumpCreateEventFixture, pumpTradeEventFixture } from "./fixtures/pump.js";

describe("PumpFunDetector", () => {
  it("emits one normalized candidate for duplicate log delivery", async () => {
    const eventBus = createEventBus();
    const received: string[] = [];
    eventBus.on("LaunchpadTokenCreated", ({ candidate }) => {
      received.push(candidate.address);
    });
    const connection = {
      onLogs: vi.fn(() => 42),
      removeOnLogsListener: vi.fn(async () => undefined),
      getParsedTransaction: vi.fn(async () => null),
    } as unknown as Pick<Connection, "onLogs" | "removeOnLogsListener" | "getParsedTransaction">;
    const detector = new PumpFunDetector({
      connection,
      programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      commitment: "processed",
      eventBus,
      logger: pino({ level: "silent" }),
    });
    const logs = {
      signature: "test-signature",
      err: null,
      logs: [`Program data: ${pumpCreateEventFixture().toString("base64")}`],
    };
    const observedAt = new Date("2026-09-10T16:26:41.000Z");

    await detector.processLogs(logs, 123, observedAt);
    await detector.processLogs(logs, 123, observedAt);

    expect(received).toHaveLength(1);
    expect(detector.status().lastEventAt).toEqual(observedAt);
    expect(connection.getParsedTransaction).not.toHaveBeenCalled();
  });

  it("subscribes and cleanly removes its listener", async () => {
    const connection = {
      onLogs: vi.fn(() => 42),
      removeOnLogsListener: vi.fn(async () => undefined),
      getParsedTransaction: vi.fn(async () => null),
    } as unknown as Pick<Connection, "onLogs" | "removeOnLogsListener" | "getParsedTransaction">;
    const detector = new PumpFunDetector({
      connection,
      programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      commitment: "processed",
      eventBus: createEventBus(),
      logger: pino({ level: "silent" }),
    });
    await detector.start();
    expect(detector.status().running).toBe(true);
    await detector.stop();
    expect(connection.removeOnLogsListener).toHaveBeenCalledWith(42);
    expect(detector.status().running).toBe(false);
  });

  it("does not fetch transactions for ordinary Pump trades", async () => {
    const connection = {
      onLogs: vi.fn(() => 42),
      removeOnLogsListener: vi.fn(async () => undefined),
      getParsedTransaction: vi.fn(async () => null),
    } as unknown as Pick<Connection, "onLogs" | "removeOnLogsListener" | "getParsedTransaction">;
    const detector = new PumpFunDetector({
      connection,
      programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      commitment: "processed",
      eventBus: createEventBus(),
      logger: pino({ level: "silent" }),
    });
    await detector.processLogs(
      { signature: "trade-signature", err: null, logs: ["Program log: Instruction: Buy"] },
      123,
    );
    expect(connection.getParsedTransaction).not.toHaveBeenCalled();
  });

  it("updates a tracked token's USD market cap from trade reserves", async () => {
    const eventBus = createEventBus();
    const marketCaps: number[] = [];
    const liquidities: number[] = [];
    eventBus.on("LaunchpadTokenCreated", ({ candidate }) => {
      marketCaps.push(candidate.marketCapUsd ?? 0);
      liquidities.push(candidate.liquidityUsd ?? 0);
    });
    eventBus.on("TokenMarketCapUpdated", ({ candidate }) => {
      marketCaps.push(candidate.marketCapUsd ?? 0);
      liquidities.push(candidate.liquidityUsd ?? 0);
    });
    const connection = {
      onLogs: vi.fn(() => 42),
      removeOnLogsListener: vi.fn(async () => undefined),
      getParsedTransaction: vi.fn(async () => null),
    } as unknown as Pick<Connection, "onLogs" | "removeOnLogsListener" | "getParsedTransaction">;
    const detector = new PumpFunDetector({
      connection,
      programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      commitment: "processed",
      eventBus,
      logger: pino({ level: "silent" }),
      solUsdPrice: { currentPrice: vi.fn(async () => 200) },
    });
    await detector.processLogs({
      signature: "create",
      err: null,
      logs: [`Program data: ${pumpCreateEventFixture().toString("base64")}`],
    }, 123);
    await detector.processLogs({
      signature: "trade",
      err: null,
      logs: [`Program data: ${pumpTradeEventFixture().toString("base64")}`],
    }, 124);
    expect(marketCaps).toEqual([6_000, 12_000]);
    expect(liquidities).toEqual([12_000, 24_000]);
  });

  it("resolves largest token accounts to holder wallet addresses", async () => {
    const eventBus = createEventBus();
    const holderWallet = new PublicKey(new Uint8Array(32).fill(8));
    let holder: { address: string; balance: number; percentage?: number } | undefined;
    let holderCount: number | undefined;
    eventBus.on("LaunchpadTokenCreated", ({ candidate }) => {
      holder = candidate.holders?.[0];
      holderCount = candidate.holderCount;
    });
    const connection = {
      onLogs: vi.fn(() => 42),
      removeOnLogsListener: vi.fn(async () => undefined),
      getParsedTransaction: vi.fn(async () => null),
      getProgramAccounts: vi.fn(async () => {
        const data = Buffer.alloc(40);
        holderWallet.toBuffer().copy(data, 0);
        data.writeBigUInt64LE(500_000n, 32);
        return [{
          pubkey: new PublicKey(new Uint8Array(32).fill(9)),
          account: { data, executable: false, lamports: 1, owner: holderWallet, rentEpoch: 0 },
        }];
      }),
    } as unknown as Connection;
    const detector = new PumpFunDetector({
      connection,
      programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      commitment: "processed",
      eventBus,
      logger: pino({ level: "silent" }),
    });
    await detector.processLogs({
      signature: "holders",
      err: null,
      logs: [`Program data: ${pumpCreateEventFixture().toString("base64")}`],
    }, 123, new Date("2026-09-10T16:26:41.000Z"));
    expect(holder).toMatchObject({ address: holderWallet.toBase58(), balance: 0.5, percentage: 50 });
    expect(holderCount).toBe(1);
  });

  it("refreshes exact unique holders through Helius and attaches public labels", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: {
          total: 3,
          token_accounts: [
            { owner: "WalletA", amount: 400_000 },
            { owner: "WalletA", amount: 100_000 },
            { owner: "WalletB", amount: 250_000 },
          ],
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { address: "WalletA", name: "Known Trader" },
        { address: "WalletB", unresolved: true },
      ]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const connection = {
        onLogs: vi.fn(() => 42),
        removeOnLogsListener: vi.fn(async () => undefined),
        getParsedTransaction: vi.fn(async () => null),
      } as unknown as Pick<Connection, "onLogs" | "removeOnLogsListener" | "getParsedTransaction">;
      const detector = new PumpFunDetector({
        connection,
        programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
        commitment: "processed",
        eventBus: createEventBus(),
        logger: pino({ level: "silent" }),
        heliusApiKey: "test-key",
      });

      const refreshed = await detector.refreshHolders({
        id: "solana:mint",
        chain: "solana",
        source: "pumpfun",
        address: "MintAddress",
        decimals: 6,
        priceUsd: 2,
        discoveredAt: new Date(),
        fomoListed: false,
        metadata: { tokenTotalSupply: "1000000" },
      });

      expect(refreshed.holderCount).toBe(2);
      expect(refreshed.holders).toEqual([
        { address: "WalletA", label: "Known Trader", balance: 0.5, percentage: 50, valueUsd: 1 },
        { address: "WalletB", balance: 0.25, percentage: 25, valueUsd: 0.5 },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("verifies that a Solana mint exists under its expected token program", async () => {
    const mint = new PublicKey(new Uint8Array(32).fill(3));
    const tokenProgram = new PublicKey(new Uint8Array(32).fill(4));
    const connection = {
      onLogs: vi.fn(() => 42),
      removeOnLogsListener: vi.fn(async () => undefined),
      getParsedTransaction: vi.fn(async () => null),
      getAccountInfo: vi.fn(async () => ({
        data: Buffer.alloc(82), executable: false, lamports: 1, owner: tokenProgram, rentEpoch: 0,
      })),
    } as unknown as Connection;
    const detector = new PumpFunDetector({
      connection,
      programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      commitment: "processed",
      eventBus: createEventBus(),
      logger: pino({ level: "silent" }),
    });
    const available = await detector.isTokenAvailable({
      id: `solana:${mint.toBase58()}`,
      chain: "solana",
      source: "pumpfun",
      address: mint.toBase58(),
      tokenProgram: tokenProgram.toBase58(),
      slot: 123,
      discoveredAt: new Date(),
      fomoListed: false,
    });

    expect(available).toBe(true);
    expect(connection.getAccountInfo).toHaveBeenCalledWith(mint, { commitment: "processed", minContextSlot: 123 });
  });

  it("enriches a Pump candidate with mint and freeze authority state", async () => {
    const mintAuthority = new PublicKey(new Uint8Array(32).fill(7));
    const mintData = Buffer.alloc(82);
    mintData.writeUInt32LE(1, 0);
    mintAuthority.toBuffer().copy(mintData, 4);
    mintData.writeBigUInt64LE(1_000_000n, 36);
    mintData[44] = 6;
    mintData[45] = 1;
    mintData.writeUInt32LE(0, 46);
    const eventBus = createEventBus();
    let received: TokenCandidate | undefined;
    eventBus.on("LaunchpadTokenCreated", ({ candidate }) => { received = candidate; });
    const connection = {
      onLogs: vi.fn(() => 42),
      removeOnLogsListener: vi.fn(async () => undefined),
      getParsedTransaction: vi.fn(async () => null),
      getAccountInfo: vi.fn(async () => ({
        data: mintData,
        executable: false,
        lamports: 1,
        owner: new PublicKey(new Uint8Array(32).fill(5)),
        rentEpoch: 0,
      })),
    } as unknown as Connection;
    const detector = new PumpFunDetector({
      connection,
      programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      commitment: "processed",
      eventBus,
      logger: pino({ level: "silent" }),
    });

    await detector.processLogs({
      signature: "mint-risk",
      err: null,
      logs: [`Program data: ${pumpCreateEventFixture().toString("base64")}`],
    }, 123);

    expect(received?.metadata).toMatchObject({
      mintAccountVerified: true,
      mintAuthority: mintAuthority.toBase58(),
      freezeAuthority: null,
      mintAccountSize: 82,
    });
  });
});

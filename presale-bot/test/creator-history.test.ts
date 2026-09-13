import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { createCreatorHistoryService, createHeliusCreatorFundingProvider, gateCreatorHistory } from "../src/creators/history.js";
import type { TokenCandidate } from "../src/domain/token-candidate.js";

const baseCandidate: TokenCandidate = {
  id: "solana:mint-one",
  chain: "solana",
  source: "pumpfun",
  address: "mint-one",
  creator: "CreatorWallet",
  discoveredAt: new Date("2026-09-13T10:00:00.000Z"),
  marketCapUsd: 100_000,
  liquidityUsd: 30_000,
  holders: [{ address: "CreatorWallet", balance: 200_000, percentage: 20 }],
  fomoListed: false,
};

describe("creator history", () => {
  it("does not process candidates while creator history is disabled", async () => {
    let enabled = false;
    const enrich = vi.fn(async (candidate: TokenCandidate) => candidate);
    const gated = gateCreatorHistory({ enrich, flush: vi.fn(async () => undefined) }, () => enabled);
    await expect(gated.enrich(baseCandidate)).resolves.toBe(baseCandidate);
    expect(enrich).not.toHaveBeenCalled();
    enabled = true;
    await gated.enrich(baseCandidate);
    expect(enrich).toHaveBeenCalledOnce();
  });

  it("tracks launches, drawdowns, liquidity outcomes, holdings, and the first observed sale", async () => {
    let current = new Date("2026-09-13T10:01:00.000Z");
    const service = createCreatorHistoryService({
      logger: pino({ level: "silent" }),
      meaningfulLiquidityUsd: 25_000,
      now: () => current,
    });

    const first = await service.enrich(baseCandidate);
    expect(first.creatorHistory).toMatchObject({
      observedLaunches: 1,
      previousObservedLaunches: 0,
      reachedMeaningfulLiquidity: 1,
      currentHoldingPercent: 20,
      lostNinetyPercent: 0,
      severeLiquidityDrops: 0,
    });

    current = new Date("2026-09-13T10:06:00.000Z");
    const collapsed = await service.enrich({
      ...baseCandidate,
      marketCapUsd: 9_000,
      liquidityUsd: 2_000,
      holders: [{ address: "CreatorWallet", balance: 100_000, percentage: 10 }],
    });
    expect(collapsed.creatorHistory).toMatchObject({
      lostNinetyPercent: 1,
      severeLiquidityDrops: 1,
      currentHoldingPercent: 10,
      firstObservedSaleAt: "2026-09-13T10:06:00.000Z",
    });

    current = new Date("2026-09-13T10:07:00.000Z");
    const second = await service.enrich({
      ...baseCandidate,
      id: "solana:mint-two",
      address: "mint-two",
      discoveredAt: current,
      marketCapUsd: 5_000,
      liquidityUsd: 1_000,
    });
    expect(second.creatorHistory).toMatchObject({
      observedLaunches: 2,
      previousObservedLaunches: 1,
      reachedMeaningfulLiquidity: 1,
      lostNinetyPercent: 1,
      severeLiquidityDrops: 1,
    });
  });

  it("persists observations across service restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "creator-history-"));
    const filePath = join(directory, "history.json");
    try {
      const first = createCreatorHistoryService({ logger: pino({ level: "silent" }), filePath });
      await first.enrich(baseCandidate);
      await first.flush();

      const restarted = createCreatorHistoryService({ logger: pino({ level: "silent" }), filePath });
      const result = await restarted.enrich({ ...baseCandidate, id: "solana:mint-two", address: "mint-two" });
      expect(result.creatorHistory?.observedLaunches).toBe(2);
      await restarted.flush();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("normalizes and caches Helius creator funding data", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      funder: "FundingWallet",
      funderName: "Binance",
      funderType: "EXCHANGE",
      fundedAmount: 1.25,
      fundedAt: 1_757_757_600,
    }), { status: 200 }));
    const provider = createHeliusCreatorFundingProvider("key", { fetch: fetcher as typeof fetch });

    await expect(provider.lookup("CreatorWallet")).resolves.toMatchObject({
      address: "FundingWallet",
      label: "Binance",
      type: "EXCHANGE",
      amount: 1.25,
      symbol: "SOL",
      fundedAt: "2025-09-13T10:00:00.000Z",
    });
    await provider.lookup("CreatorWallet");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from "vitest";
import { calculatePumpLiquidityAnalysis, calculatePumpMarketCapUsd, calculatePumpTokenPriceUsd, createSolUsdPriceService } from "../src/chains/solana/pumpfun/market-cap.js";
import { createBnbUsdPriceService } from "../src/chains/evm/market-data.js";
import { constantProductBuyImpactPercent } from "../src/liquidity/liquidity-analysis.js";

describe("market capitalization", () => {
  it("calculates USD market cap from Pump.fun bonding-curve reserves", () => {
    expect(calculatePumpMarketCapUsd({
      virtualQuoteReserves: 30_000_000_000n,
      virtualTokenReserves: 1_073_000_000_000_000n,
    }, 1_000_000_000_000_000n, 200)).toBeCloseTo(5_591.8, 1);
  });

  it("calculates the current USD token price from Pump.fun reserves", () => {
    expect(calculatePumpTokenPriceUsd({
      virtualQuoteReserves: 30_000_000_000n,
      virtualTokenReserves: 1_073_000_000_000_000n,
    }, 200)).toBeCloseTo(0.0000055918, 10);
  });

  it("calculates Pump virtual liquidity and preset price-impact estimates", () => {
    const analysis = calculatePumpLiquidityAnalysis({
      virtualQuoteReserves: 30_000_000_000n,
      virtualTokenReserves: 1_073_000_000_000_000n,
    }, 200, 5_591.8);
    expect(analysis?.effectiveLiquidityUsd).toBeCloseTo(12_000);
    expect(analysis?.quoteReserve).toBe(30);
    expect(analysis?.priceImpactEstimates).toEqual([
      { tradeUsd: 25, impactPercent: expect.closeTo(0.416667, 5) },
      { tradeUsd: 50, impactPercent: expect.closeTo(0.833333, 5) },
      { tradeUsd: 100, impactPercent: expect.closeTo(1.666667, 5) },
    ]);
    expect(analysis?.controlStatus).toBe("PROGRAM_CONTROLLED");
  });

  it("includes an AMM input fee in constant-product price impact", () => {
    expect(constantProductBuyImpactPercent(100, 1, 0)).toBeCloseTo(1);
    expect(constantProductBuyImpactPercent(100, 1, 0.003)).toBeCloseTo(1.3009, 3);
  });

  it("caches the SOL/USD price", async () => {
    const fetchPrice = vi.fn(async () => new Response(JSON.stringify({ price: "200.50" })));
    const service = createSolUsdPriceService({ fetch: fetchPrice as typeof fetch });
    await expect(service.currentPrice()).resolves.toBe(200.5);
    await expect(service.currentPrice()).resolves.toBe(200.5);
    expect(fetchPrice).toHaveBeenCalledTimes(1);
  });

  it("loads and caches the BNB/USD price for BSC valuations", async () => {
    const fetchPrice = vi.fn(async (_input: string | URL | Request) =>
      new Response(JSON.stringify({ price: "612.75" })));
    const service = createBnbUsdPriceService({ fetch: fetchPrice as typeof fetch });
    await expect(service.currentPrice()).resolves.toBe(612.75);
    await expect(service.currentPrice()).resolves.toBe(612.75);
    expect(fetchPrice).toHaveBeenCalledTimes(1);
    expect(fetchPrice.mock.calls[0]?.[0]).toContain("symbol=BNBUSDT");
  });
});

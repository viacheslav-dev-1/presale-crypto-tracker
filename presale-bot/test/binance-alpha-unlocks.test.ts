import { describe, expect, it } from "vitest";
import {
  createBinanceAlphaUnlockService,
  formatBinanceAlphaUnlocks,
  TokenUnlockConfigurationError,
  utcMonthRange,
} from "../src/features/binance-alpha-unlocks.js";

describe("Binance Alpha token unlocks", () => {
  it("uses CoinMarketCap's free public unlock feed by default", async () => {
    const requested: string[] = [];
    const service = createBinanceAlphaUnlockService({
      fetch: async (url) => {
        requested.push(url);
        return {
          ok: true,
          status: 200,
          async json() {
            if (url.includes("fapi.binance.com")) {
              return { symbols: [{ symbol: "FREEUSDT", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING" }] };
            }
            if (url.includes("alpha/all/token/list")) {
              return { data: [{
                alphaId: "ALPHA_10",
                chainId: "56",
                chainName: "BSC",
                contractAddress: "0xabc",
                name: "Free Feed",
                symbol: "FREE",
                totalSupply: "1000",
                circulatingSupply: "300",
              }] };
            }
            return { data: {
              totalCount: "1",
              tokenUnlockList: [{
                cryptoId: 10,
                name: "Free Feed",
                symbol: "FREE",
                tokenUnlockedAmount: 400,
                tokenLockedAmount: 600,
                nextUnlocked: {
                  tokenAmount: 100,
                  tokenAmountPercentage: 10,
                  date: Date.UTC(2026, 8, 20),
                },
              }],
            } };
          },
        };
      },
    });

    const unlocks = await service.listUnlocks(new Date("2026-09-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
    expect(requested.some((url) => url.includes("api.coinmarketcap.com/data-api/v3/token-unlock/listing"))).toBe(true);
    expect(unlocks).toHaveLength(1);
    expect(unlocks[0]).toMatchObject({ symbol: "FREE", unlockedPercent: 40, lockedPercent: 60 });
    await service.listUnlocks(new Date("2026-09-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
    expect(requested.filter((url) => url.includes("fapi.binance.com"))).toHaveLength(1);
  });

  it("keeps only Binance Alpha Futures tokens and sorts by date, then unlock percentage", async () => {
    const service = createBinanceAlphaUnlockService({
      cryptoRankApiKey: "test-key",
      provider: "cryptorank",
      fetch: async (url) => ({
        ok: true,
        status: 200,
        async json() {
          if (url.includes("fapi.binance.com")) {
            return { symbols: [
              { symbol: "SMLUSDT", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING" },
              { symbol: "LRGUSDT", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING" },
              { symbol: "MEDUSDT", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING" },
              { symbol: "OLDUSDT", quoteAsset: "USDT", contractType: "PERPETUAL", status: "SETTLING" },
            ] };
          }
          if (url.includes("alpha/all/token/list")) {
            return { data: [
              { alphaId: "ALPHA_1", chainId: "56", chainName: "BSC", contractAddress: "0xaaa", name: "Small", symbol: "SML", totalSupply: "1000", circulatingSupply: "800" },
              { alphaId: "ALPHA_2", chainId: "8453", chainName: "Base", contractAddress: "0xbbb", name: "Large", symbol: "LRG", totalSupply: "1000", circulatingSupply: "250" },
              { alphaId: "ALPHA_3", chainId: "8453", chainName: "Base", contractAddress: "0xccc", name: "No Futures", symbol: "NOF", totalSupply: "1000", circulatingSupply: "250" },
              { alphaId: "ALPHA_4", chainId: "8453", chainName: "Base", contractAddress: "0xddd", name: "Medium", symbol: "MED", totalSupply: "2000", circulatingSupply: "500" },
            ] };
          }
          return { data: [
            { id: 1, name: "Small", symbol: "SML", time: Date.UTC(2026, 8, 18), unlockTokens: "10", percentOfSupply: 1 },
            { id: 2, name: "Large", symbol: "LRG", time: Date.UTC(2026, 8, 20), unlockTokens: "300", percentOfSupply: 30 },
            { id: 3, name: "Not Alpha", symbol: "NOPE", time: Date.UTC(2026, 8, 19), unlockTokens: "900", percentOfSupply: 90 },
            { id: 4, name: "No Futures", symbol: "NOF", time: Date.UTC(2026, 8, 19), unlockTokens: "900", percentOfSupply: 90 },
            { id: 5, name: "Medium", symbol: "MED", time: Date.UTC(2026, 8, 20), unlockTokens: "400", percentOfSupply: 20 },
          ] };
        },
      }),
    });

    const unlocks = await service.listUnlocks(new Date("2026-09-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
    expect(unlocks.map((unlock) => unlock.symbol)).toEqual(["SML", "LRG", "MED"]);
    expect(unlocks[1]).toMatchObject({ lockedPercent: 75, unlockedPercent: 25 });
    expect(unlocks[1]?.binanceUrl).toBe("https://www.binance.com/en/futures/LRGUSDT");
  });

  it("formats numbered linked entries with two blank lines between tokens", () => {
    const text = formatBinanceAlphaUnlocks([
      { id: "1", name: "Alpha", symbol: "ALP", unlockAt: new Date("2026-09-18T13:30:00Z"), unlockTokens: 100, unlockPercentOfSupply: 10, lockedPercent: 60, unlockedPercent: 40, binanceUrl: "https://example.com/alpha" },
      { id: "2", name: "Beta", symbol: "BET", unlockAt: new Date("2026-09-20T00:00:00Z"), unlockTokens: 50, unlockPercentOfSupply: 5, lockedPercent: 20, unlockedPercent: 80, binanceUrl: "https://example.com/beta" },
    ], "Top 10");

    expect(text).toContain('1. ⚡ <b>Alpha (ALP)</b> [<a href="https://example.com/alpha">LINK</a>]');
    expect(text).toContain("🔒 Locked: <b>60%</b>, Unlocked: <b>40%</b>");
    expect(text).toContain("🔑 This unlock: <b>10%</b> of total supply");
    expect(text).toContain("📅 September 18, 2026, 13:30 UTC");
    expect(text).toContain("📅 September 20, 2026, 00:00 UTC");
    expect(text).toContain("UTC\n\n\n2. ⚡");
  });

  it("shows additional precision for small non-zero unlock percentages", () => {
    const text = formatBinanceAlphaUnlocks([
      { id: "1", name: "Small", symbol: "SML", unlockAt: new Date("2026-09-18T00:00:00Z"), unlockTokens: 1, unlockPercentOfSupply: 0.0042, lockedPercent: 60, unlockedPercent: 40, binanceUrl: "https://example.com/small" },
      { id: "2", name: "Tiny", symbol: "TNY", unlockAt: new Date("2026-09-18T00:00:00Z"), unlockTokens: 1, unlockPercentOfSupply: 0.00001, lockedPercent: 60, unlockedPercent: 40, binanceUrl: "https://example.com/tiny" },
    ], "Small unlocks");

    expect(text).toContain("🔑 This unlock: <b>0.0042%</b> of total supply");
    expect(text).toContain("🔑 This unlock: <b>&lt;0.0001%</b> of total supply");
  });

  it("builds current and next UTC month ranges across a year boundary", () => {
    expect(utcMonthRange(new Date("2026-12-15T20:00:00Z"), 0)).toEqual({
      from: new Date("2026-12-01T00:00:00Z"),
      to: new Date("2027-01-01T00:00:00Z"),
    });
    expect(utcMonthRange(new Date("2026-12-15T20:00:00Z"), 1)).toEqual({
      from: new Date("2027-01-01T00:00:00Z"),
      to: new Date("2027-02-01T00:00:00Z"),
    });
  });

  it("reports when the configured CryptoRank plan does not include unlocks", async () => {
    const service = createBinanceAlphaUnlockService({
      cryptoRankApiKey: "limited-plan-key",
      provider: "cryptorank",
      fetch: async (url) => ({
        ok: !url.includes("cryptorank.io"),
        status: url.includes("cryptorank.io") ? 403 : 200,
        async json() {
          return url.includes("cryptorank.io")
            ? { error: { code: "ENDPOINT_NOT_AVAILABLE", message: "Endpoint is not available in your plan" } }
            : { data: [] };
        },
      }),
    });

    await expect(service.listUnlocks(
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-10-01T00:00:00Z"),
    )).rejects.toThrowError(TokenUnlockConfigurationError);
    await expect(service.listUnlocks(
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-10-01T00:00:00Z"),
    )).rejects.toThrow(/plan does not include/i);
  });
});

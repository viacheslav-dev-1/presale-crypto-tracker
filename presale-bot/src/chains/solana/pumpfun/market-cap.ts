import type { PumpCreation, PumpTrade } from "./decoder.js";
import type { LiquidityAnalysis } from "../../../domain/token-candidate.js";
import { liquidityToMarketCapPercent, priceImpactEstimates } from "../../../liquidity/liquidity-analysis.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface SolUsdPriceService {
  currentPrice(): Promise<number>;
}

export function createSolUsdPriceService(options: {
  fetch?: typeof fetch;
  cacheMilliseconds?: number;
} = {}): SolUsdPriceService {
  const fetchPrice = options.fetch ?? fetch;
  const cacheMilliseconds = options.cacheMilliseconds ?? 60_000;
  let cached: { price: number; expiresAt: number } | undefined;
  let pending: Promise<number> | undefined;

  return {
    async currentPrice() {
      if (cached && cached.expiresAt > Date.now()) return cached.price;
      if (pending) return pending;
      pending = (async () => {
        const response = await fetchPrice("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", {
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`SOL/USD price request failed with HTTP ${response.status}`);
        const payload: unknown = await response.json();
        const price = typeof payload === "object" && payload !== null && "price" in payload
          ? Number((payload as { price: unknown }).price)
          : Number.NaN;
        if (!Number.isFinite(price) || price <= 0) throw new Error("SOL/USD price response is invalid");
        cached = { price, expiresAt: Date.now() + cacheMilliseconds };
        return price;
      })();
      try {
        return await pending;
      } finally {
        pending = undefined;
      }
    },
  };
}

export function calculatePumpMarketCapUsd(
  reserves: Pick<PumpCreation | PumpTrade, "virtualTokenReserves" | "virtualQuoteReserves">,
  tokenTotalSupply: bigint | undefined,
  solUsdPrice: number,
): number | undefined {
  if (!reserves.virtualTokenReserves || !reserves.virtualQuoteReserves || !tokenTotalSupply) return undefined;
  if (reserves.virtualTokenReserves <= 0n || reserves.virtualQuoteReserves <= 0n || tokenTotalSupply <= 0n) return undefined;
  const marketCapSol = Number(reserves.virtualQuoteReserves) * Number(tokenTotalSupply) /
    (Number(reserves.virtualTokenReserves) * LAMPORTS_PER_SOL);
  const marketCapUsd = marketCapSol * solUsdPrice;
  return Number.isFinite(marketCapUsd) && marketCapUsd >= 0 ? marketCapUsd : undefined;
}

export function calculatePumpTokenPriceUsd(
  reserves: Pick<PumpCreation | PumpTrade, "virtualTokenReserves" | "virtualQuoteReserves">,
  solUsdPrice: number,
): number | undefined {
  if (!reserves.virtualTokenReserves || !reserves.virtualQuoteReserves) return undefined;
  if (reserves.virtualTokenReserves <= 0n || reserves.virtualQuoteReserves <= 0n) return undefined;
  const virtualTokens = Number(reserves.virtualTokenReserves) / 1_000_000;
  const virtualSol = Number(reserves.virtualQuoteReserves) / LAMPORTS_PER_SOL;
  const priceUsd = virtualSol / virtualTokens * solUsdPrice;
  return Number.isFinite(priceUsd) && priceUsd >= 0 ? priceUsd : undefined;
}

export function calculatePumpLiquidityAnalysis(
  reserves: Pick<PumpCreation | PumpTrade, "virtualTokenReserves" | "virtualQuoteReserves">,
  solUsdPrice: number,
  marketCapUsd: number | undefined,
): LiquidityAnalysis | undefined {
  if (!reserves.virtualTokenReserves || !reserves.virtualQuoteReserves ||
    reserves.virtualTokenReserves <= 0n || reserves.virtualQuoteReserves <= 0n ||
    !Number.isFinite(solUsdPrice) || solUsdPrice <= 0) return undefined;
  const tokenReserve = Number(reserves.virtualTokenReserves) / 1_000_000;
  const quoteReserve = Number(reserves.virtualQuoteReserves) / LAMPORTS_PER_SOL;
  const effectiveLiquidityUsd = quoteReserve * solUsdPrice * 2;
  if (![tokenReserve, quoteReserve, effectiveLiquidityUsd].every(Number.isFinite)) return undefined;
  const ratio = liquidityToMarketCapPercent(effectiveLiquidityUsd, marketCapUsd);
  return {
    venueType: "BONDING_CURVE",
    effectiveLiquidityUsd,
    tokenReserve,
    quoteReserve,
    quoteSymbol: "SOL",
    ...(ratio !== undefined ? { liquidityToMarketCapPercent: ratio } : {}),
    priceImpactEstimates: priceImpactEstimates(quoteReserve, solUsdPrice),
    controlStatus: "PROGRAM_CONTROLLED",
    controlDescription: "Pump.fun bonding curve program controls the reserves",
    warnings: [
      "Effective liquidity uses virtual curve reserves; it is not proof of withdrawable or locked LP value",
      "Price-impact estimates exclude Pump.fun fees, priority fees, MEV, and state changes before execution",
    ],
  };
}

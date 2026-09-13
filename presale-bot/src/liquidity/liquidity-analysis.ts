import type { PriceImpactEstimate } from "../domain/token-candidate.js";

export const DEFAULT_LIQUIDITY_TEST_AMOUNTS_USD = [25, 50, 100] as const;

/**
 * Estimates average execution-price impact against a constant-product curve.
 * The estimate includes the supplied input fee but excludes gas, priority fees,
 * transfer taxes, MEV, and state changes before execution.
 */
export function constantProductBuyImpactPercent(
  quoteReserve: number,
  tradeQuoteAmount: number,
  inputFeeFraction = 0,
): number | undefined {
  if (!Number.isFinite(quoteReserve) || quoteReserve <= 0 ||
    !Number.isFinite(tradeQuoteAmount) || tradeQuoteAmount <= 0 ||
    !Number.isFinite(inputFeeFraction) || inputFeeFraction < 0 || inputFeeFraction >= 1) return undefined;
  const effectiveInput = tradeQuoteAmount * (1 - inputFeeFraction);
  const impact = tradeQuoteAmount / effectiveInput * (1 + effectiveInput / quoteReserve) - 1;
  const percent = impact * 100;
  return Number.isFinite(percent) && percent >= 0 ? percent : undefined;
}

export function priceImpactEstimates(
  quoteReserve: number,
  quoteUsdPrice: number,
  inputFeeFraction = 0,
  tradeAmountsUsd: readonly number[] = DEFAULT_LIQUIDITY_TEST_AMOUNTS_USD,
): readonly PriceImpactEstimate[] {
  if (!Number.isFinite(quoteUsdPrice) || quoteUsdPrice <= 0) return [];
  return tradeAmountsUsd.flatMap((tradeUsd) => {
    const impactPercent = constantProductBuyImpactPercent(
      quoteReserve,
      tradeUsd / quoteUsdPrice,
      inputFeeFraction,
    );
    return impactPercent === undefined ? [] : [{ tradeUsd, impactPercent }];
  });
}

export function liquidityToMarketCapPercent(
  liquidityUsd: number,
  marketCapUsd: number | undefined,
): number | undefined {
  if (marketCapUsd === undefined || !Number.isFinite(marketCapUsd) || marketCapUsd <= 0 ||
    !Number.isFinite(liquidityUsd) || liquidityUsd < 0) return undefined;
  return liquidityUsd / marketCapUsd * 100;
}

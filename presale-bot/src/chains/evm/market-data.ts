export interface NativeUsdPriceService {
  currentPrice(): Promise<number>;
}

function createBinanceNativeUsdPriceService(symbol: "BNB" | "ETH", options: {
  fetch?: typeof fetch;
  cacheMilliseconds?: number;
} = {}): NativeUsdPriceService {
  const fetchPrice = options.fetch ?? fetch;
  const cacheMilliseconds = options.cacheMilliseconds ?? 60_000;
  let cached: { price: number; expiresAt: number } | undefined;
  let pending: Promise<number> | undefined;

  return {
    async currentPrice() {
      if (cached && cached.expiresAt > Date.now()) return cached.price;
      if (pending) return pending;
      pending = (async () => {
        const response = await fetchPrice(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`${symbol}/USD price request failed with HTTP ${response.status}`);
        const payload: unknown = await response.json();
        const price = typeof payload === "object" && payload !== null && "price" in payload
          ? Number((payload as { price: unknown }).price)
          : Number.NaN;
        if (!Number.isFinite(price) || price <= 0) throw new Error(`${symbol}/USD price response is invalid`);
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

export function createEthUsdPriceService(options: {
  fetch?: typeof fetch;
  cacheMilliseconds?: number;
} = {}): NativeUsdPriceService {
  return createBinanceNativeUsdPriceService("ETH", options);
}

export function createBnbUsdPriceService(options: {
  fetch?: typeof fetch;
  cacheMilliseconds?: number;
} = {}): NativeUsdPriceService {
  return createBinanceNativeUsdPriceService("BNB", options);
}

export function priceFromSqrtPriceX96(
  sqrtPriceX96: bigint,
  candidateIsToken0: boolean,
  candidateDecimals: number,
  quoteDecimals: number,
): number | undefined {
  if (sqrtPriceX96 <= 0n) return undefined;
  const sqrtRatio = Number(sqrtPriceX96) / 2 ** 96;
  const rawRatio = sqrtRatio * sqrtRatio;
  const decimalScale = 10 ** (candidateDecimals - quoteDecimals);
  const quotePerToken = (candidateIsToken0 ? rawRatio : 1 / rawRatio) * decimalScale;
  return Number.isFinite(quotePerToken) && quotePerToken > 0 ? quotePerToken : undefined;
}

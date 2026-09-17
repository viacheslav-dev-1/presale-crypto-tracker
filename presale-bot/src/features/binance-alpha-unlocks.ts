export interface BinanceAlphaTokenUnlock {
  id: string;
  name: string;
  symbol: string;
  unlockAt: Date;
  unlockTokens: number;
  unlockPercentOfSupply: number;
  lockedPercent: number;
  unlockedPercent: number;
  binanceUrl: string;
}

export interface BinanceAlphaUnlockService {
  listUnlocks(from: Date, to: Date): Promise<readonly BinanceAlphaTokenUnlock[]>;
}

export class TokenUnlockConfigurationError extends Error {}

interface BinanceAlphaApiToken {
  alphaId?: unknown;
  chainId?: unknown;
  chainName?: unknown;
  contractAddress?: unknown;
  name?: unknown;
  symbol?: unknown;
  totalSupply?: unknown;
  circulatingSupply?: unknown;
  offline?: unknown;
  fullyDelisted?: unknown;
}

interface CryptoRankUnlockEvent {
  id?: unknown;
  name?: unknown;
  symbol?: unknown;
  time?: unknown;
  unlockTokens?: unknown;
  percentOfSupply?: unknown;
  totalUnlocked?: unknown;
  totalLocked?: unknown;
}

interface BinanceFuturesSymbol {
  symbol?: unknown;
  quoteAsset?: unknown;
  contractType?: unknown;
  status?: unknown;
}

interface JsonResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FetchJson = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<JsonResponse>;

export interface BinanceAlphaUnlockServiceOptions {
  cryptoRankApiKey?: string;
  provider?: "coinmarketcap" | "cryptorank";
  fetch?: FetchJson;
  timeoutMs?: number;
}

const BINANCE_ALPHA_TOKEN_LIST =
  "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list";
const BINANCE_USDT_FUTURES_EXCHANGE_INFO = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const CRYPTORANK_UNLOCKS = "https://api.cryptorank.io/v3/currencies/upcoming-token-unlocks";
const COINMARKETCAP_UNLOCKS = "https://api.coinmarketcap.com/data-api/v3/token-unlock/listing";

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestamp(value: unknown): Date | undefined {
  const parsed = asFiniteNumber(value);
  if (parsed === undefined) return undefined;
  const date = new Date(parsed < 10_000_000_000 ? parsed * 1_000 : parsed);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function binanceFuturesUrl(futuresSymbol: string): string {
  return `https://www.binance.com/en/futures/${encodeURIComponent(futuresSymbol)}`;
}

function activeUsdtFuturesSymbols(value: unknown): Set<string> {
  if (typeof value !== "object" || value === null) return new Set();
  const symbols = (value as { symbols?: unknown }).symbols;
  if (!Array.isArray(symbols)) return new Set();
  return new Set(symbols.flatMap((item): string[] => {
    if (typeof item !== "object" || item === null) return [];
    const contract = item as BinanceFuturesSymbol;
    const symbol = asString(contract.symbol)?.toUpperCase();
    return symbol && asString(contract.quoteAsset)?.toUpperCase() === "USDT"
      && asString(contract.contractType)?.toUpperCase() === "PERPETUAL"
      && asString(contract.status)?.toUpperCase() === "TRADING"
      ? [symbol]
      : [];
  }));
}

function eventArray(value: unknown): CryptoRankUnlockEvent[] {
  if (typeof value !== "object" || value === null) return [];
  const data = (value as { data?: unknown }).data;
  return Array.isArray(data) ? data as CryptoRankUnlockEvent[] : [];
}

function coinMarketCapEventArray(value: unknown): CryptoRankUnlockEvent[] {
  if (typeof value !== "object" || value === null) return [];
  const data = (value as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return [];
  const list = (data as { tokenUnlockList?: unknown }).tokenUnlockList;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): CryptoRankUnlockEvent[] => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const next = typeof record.nextUnlocked === "object" && record.nextUnlocked !== null
      ? record.nextUnlocked as Record<string, unknown>
      : undefined;
    if (!next) return [];
    return [{
      id: record.cryptoId ?? record.id,
      name: record.name,
      symbol: record.symbol,
      time: next.date,
      unlockTokens: next.tokenAmount,
      percentOfSupply: next.tokenAmountPercentage,
      totalUnlocked: record.tokenUnlockedAmount,
      totalLocked: record.tokenLockedAmount,
    }];
  });
}

function coinMarketCapTotalCount(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  const data = (value as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return 0;
  return asFiniteNumber((data as { totalCount?: unknown }).totalCount) ?? 0;
}

function alphaTokenArray(value: unknown): BinanceAlphaApiToken[] {
  if (typeof value !== "object" || value === null) return [];
  const data = (value as { data?: unknown }).data;
  return Array.isArray(data) ? data as BinanceAlphaApiToken[] : [];
}

export function createBinanceAlphaUnlockService(
  options: BinanceAlphaUnlockServiceOptions = {},
): BinanceAlphaUnlockService {
  const apiKey = options.cryptoRankApiKey?.trim();
  const provider = options.provider ?? "coinmarketcap";
  const request = options.fetch ?? (globalThis.fetch as unknown as FetchJson);
  const timeoutMs = options.timeoutMs ?? 15_000;
  let coinMarketCapCache: { expiresAt: number; events: CryptoRankUnlockEvent[] } | undefined;
  let futuresSymbolsCache: { expiresAt: number; symbols: Set<string> } | undefined;

  const fetchJson = async (url: string, headers?: Record<string, string>): Promise<unknown> => {
    const response = await request(url, {
      ...(headers ? { headers } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = undefined;
      }
      if (url.startsWith(CRYPTORANK_UNLOCKS) && (response.status === 401 || response.status === 403)) {
        const record = typeof errorBody === "object" && errorBody !== null
          ? errorBody as Record<string, unknown>
          : {};
        const nested = typeof record.error === "object" && record.error !== null
          ? record.error as Record<string, unknown>
          : {};
        const code = asString(nested.code) ?? asString(record.code);
        if (code === "ENDPOINT_NOT_AVAILABLE" || response.status === 403) {
          throw new TokenUnlockConfigurationError(
            "Your CryptoRank plan does not include the Token Unlock API. Upgrade the plan or configure a key with unlock access.",
          );
        }
        throw new TokenUnlockConfigurationError(
          "The CryptoRank API key was rejected. Check CRYPTORANK_API_KEY and restart the bot.",
        );
      }
      throw new Error(`Unlock data request failed with HTTP ${response.status}`);
    }
    return response.json();
  };

  const fetchCoinMarketCapEvents = async (): Promise<CryptoRankUnlockEvent[]> => {
    if (coinMarketCapCache && coinMarketCapCache.expiresAt > Date.now()) return coinMarketCapCache.events;
    const page = async (pageNumber: number): Promise<unknown> => {
      const query = new URLSearchParams({
        start: String(pageNumber),
        limit: "100",
        sort: "next_unlocked_date",
        direction: "desc",
        enableSmallUnlocks: "true",
      });
      return fetchJson(`${COINMARKETCAP_UNLOCKS}?${query}`, { Accept: "application/json" });
    };
    const first = await page(1);
    const totalPages = Math.min(20, Math.ceil(coinMarketCapTotalCount(first) / 100));
    const remaining = totalPages > 1
      ? await Promise.all(Array.from({ length: totalPages - 1 }, (_, index) => page(index + 2)))
      : [];
    const events = [first, ...remaining].flatMap(coinMarketCapEventArray);
    coinMarketCapCache = { expiresAt: Date.now() + 15 * 60_000, events };
    return events;
  };

  const fetchFuturesSymbols = async (): Promise<Set<string>> => {
    if (futuresSymbolsCache && futuresSymbolsCache.expiresAt > Date.now()) return futuresSymbolsCache.symbols;
    const response = await fetchJson(BINANCE_USDT_FUTURES_EXCHANGE_INFO, { Accept: "application/json" });
    const symbols = activeUsdtFuturesSymbols(response);
    futuresSymbolsCache = { expiresAt: Date.now() + 15 * 60_000, symbols };
    return symbols;
  };

  return {
    async listUnlocks(from, to) {
      if (provider === "cryptorank" && !apiKey) {
        throw new TokenUnlockConfigurationError(
          "Token unlock data is not configured. Set CRYPTORANK_API_KEY to enable this feature.",
        );
      }
      if (to <= from) return [];
      const daysAhead = Math.max(1, Math.ceil((to.getTime() - Date.now()) / 86_400_000) + 1);
      const query = new URLSearchParams({
        daysAhead: String(daysAhead),
        sortBy: "unlockValue",
        sortOrder: "desc",
        pageSize: "300",
      });
      const [alphaResponse, futuresSymbols, events] = await Promise.all([
        fetchJson(BINANCE_ALPHA_TOKEN_LIST),
        fetchFuturesSymbols(),
        provider === "cryptorank"
          ? fetchJson(`${CRYPTORANK_UNLOCKS}?${query}`, { "X-Api-Key": apiKey! }).then(eventArray)
          : fetchCoinMarketCapEvents(),
      ]);

      const alphaBySymbol = new Map<string, BinanceAlphaApiToken[]>();
      for (const token of alphaTokenArray(alphaResponse)) {
        if (token.offline === true || token.fullyDelisted === true) continue;
        const symbol = asString(token.symbol)?.toUpperCase();
        if (!symbol) continue;
        alphaBySymbol.set(symbol, [...(alphaBySymbol.get(symbol) ?? []), token]);
      }

      const results: BinanceAlphaTokenUnlock[] = [];
      const seen = new Set<string>();
      for (const event of events) {
        const symbol = asString(event.symbol)?.toUpperCase();
        const unlockAt = timestamp(event.time);
        if (!symbol || !unlockAt || unlockAt < from || unlockAt >= to) continue;
        const futuresSymbol = `${symbol}USDT`;
        if (!futuresSymbols.has(futuresSymbol)) continue;
        const alphaMatches = alphaBySymbol.get(symbol);
        if (!alphaMatches?.length) continue;
        const unlockTokens = asFiniteNumber(event.unlockTokens);
        if (unlockTokens === undefined) continue;
        const alpha = alphaMatches[0];
        if (!alpha) continue;
        const totalSupply = asFiniteNumber(alpha.totalSupply);
        const circulatingSupply = asFiniteNumber(alpha.circulatingSupply);
        const alphaId = asString(alpha.alphaId);
        if (!totalSupply || circulatingSupply === undefined || !alphaId) continue;
        const key = `${alphaId}:${unlockAt.getTime()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const totalUnlocked = asFiniteNumber(event.totalUnlocked);
        const totalLocked = asFiniteNumber(event.totalLocked);
        const trackedSupply = (totalUnlocked ?? 0) + (totalLocked ?? 0);
        const unlockedPercent = trackedSupply > 0 && totalUnlocked !== undefined
          ? Math.min(100, (totalUnlocked / trackedSupply) * 100)
          : Math.min(100, (circulatingSupply / totalSupply) * 100);
        const lockedPercent = trackedSupply > 0 && totalLocked !== undefined
          ? Math.min(100, (totalLocked / trackedSupply) * 100)
          : Math.max(0, 100 - unlockedPercent);
        results.push({
          id: key,
          name: asString(alpha.name) ?? asString(event.name) ?? symbol,
          symbol,
          unlockAt,
          unlockTokens,
          unlockPercentOfSupply: asFiniteNumber(event.percentOfSupply) ?? (unlockTokens / totalSupply) * 100,
          unlockedPercent,
          lockedPercent,
          binanceUrl: binanceFuturesUrl(futuresSymbol),
        });
      }
      return results.sort((left, right) =>
        left.unlockAt.getTime() - right.unlockAt.getTime() ||
        right.unlockPercentOfSupply - left.unlockPercentOfSupply ||
        right.unlockTokens - left.unlockTokens);
    },
  };
}

export function utcMonthRange(now: Date, monthOffset: 0 | 1): { from: Date; to: Date } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset + 1, 1));
  return { from, to };
}

export function utcDayRange(now: Date, dayOffset: number): { from: Date; to: Date } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset));
  const to = new Date(from.getTime() + 86_400_000);
  return { from, to };
}

const escapeHtml = (value: string) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const percent = (value: number) => `${value.toFixed(2).replace(/\.00$/, "")}%`;

const unlockEventPercent = (value: number) => {
  if (value === 0) return "0%";
  if (value < 0.0001) return "&lt;0.0001%";
  if (value < 0.01) return `${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}%`;
  return percent(value);
};

function unlockDate(value: Date): string {
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(value);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(value);
  return `${date}, ${time} UTC`;
}

export function formatBinanceAlphaUnlocks(
  unlocks: readonly BinanceAlphaTokenUnlock[],
  title: string,
): string {
  const top = unlocks.slice(0, 10);
  if (top.length === 0) return `<b>${escapeHtml(title)}</b>\n\nNo Binance Alpha token unlocks were found for this period.`;
  const items = top.map((unlock, index) => [
    `${index + 1}. ⚡ <b>${escapeHtml(unlock.name)} (${escapeHtml(unlock.symbol)})</b> [<a href="${escapeHtml(unlock.binanceUrl)}">LINK</a>]`,
    `🔒 Locked: <b>${percent(unlock.lockedPercent)}</b>, Unlocked: <b>${percent(unlock.unlockedPercent)}</b>`,
    `🔑 This unlock: <b>${unlockEventPercent(unlock.unlockPercentOfSupply)}</b> of total supply`,
    `📅 ${escapeHtml(unlockDate(unlock.unlockAt))}`,
  ].join("\n"));
  return [`<b>${escapeHtml(title)}</b>`, "", ...items.flatMap((item, index) => index === 0 ? [item] : ["", "", item])].join("\n");
}

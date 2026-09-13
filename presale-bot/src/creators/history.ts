import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { rename, writeFile } from "node:fs/promises";
import type { Logger } from "pino";
import type { Chain, CreatorFunding, CreatorHistory, TokenCandidate } from "../domain/token-candidate.js";

interface TokenObservation {
  id: string;
  address: string;
  symbol?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  peakMarketCapUsd?: number;
  currentMarketCapUsd?: number;
  peakLiquidityUsd?: number;
  currentLiquidityUsd?: number;
  lastCreatorHoldingPercent?: number;
  firstObservedSaleAt?: string;
  reachedMeaningfulLiquidity: boolean;
  lostNinetyPercent: boolean;
  severeLiquidityDrop: boolean;
}

interface CreatorRecord {
  chain: Chain;
  creator: string;
  coverageStartedAt: string;
  tokens: Record<string, TokenObservation>;
  funding?: CreatorFunding;
}

interface StoredCreatorHistory {
  version: 1;
  creators: Record<string, CreatorRecord>;
}

export interface CreatorFundingProvider {
  lookup(address: string): Promise<CreatorFunding | undefined>;
}

export interface CreatorHistoryService {
  enrich(candidate: TokenCandidate): Promise<TokenCandidate>;
  flush(): Promise<void>;
}

export function gateCreatorHistory(
  service: CreatorHistoryService,
  enabled: () => boolean,
): CreatorHistoryService {
  return {
    enrich: (candidate) => enabled() ? service.enrich(candidate) : Promise.resolve(candidate),
    flush: () => service.flush(),
  };
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function creatorHolding(candidate: TokenCandidate): number | undefined {
  const indexedPercentage = candidate.metadata?.creatorHoldingPercent;
  if (typeof indexedPercentage === "number") return finiteNonNegative(indexedPercentage);
  if (!candidate.creator || !candidate.holders) return undefined;
  const creator = candidate.creator.toLowerCase();
  return finiteNonNegative(candidate.holders.find((holder) => holder.address.toLowerCase() === creator)?.percentage);
}

function recordKey(chain: Chain, creator: string): string {
  return `${chain}:${creator.toLowerCase()}`;
}

function asIsoDate(value: unknown): string | undefined {
  const date = typeof value === "string"
    ? new Date(value)
    : typeof value === "number"
      ? new Date(value < 10_000_000_000 ? value * 1_000 : value)
      : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function loadRecords(filePath: string | undefined, logger: Logger): Map<string, CreatorRecord> {
  if (!filePath) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<StoredCreatorHistory>;
    if (parsed.version !== 1 || !parsed.creators || typeof parsed.creators !== "object") return new Map();
    return new Map(Object.entries(parsed.creators));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn({ err: error, filePath }, "Unable to load creator history; starting with empty local history");
    }
    return new Map();
  }
}

export function createCreatorHistoryService(options: {
  logger: Logger;
  filePath?: string;
  meaningfulLiquidityUsd?: number;
  fundingProvider?: CreatorFundingProvider;
  now?: () => Date;
}): CreatorHistoryService {
  const threshold = options.meaningfulLiquidityUsd ?? 25_000;
  const now = options.now ?? (() => new Date());
  const records = loadRecords(options.filePath, options.logger);
  const fundingAttempts = new Set<string>();
  let saveTimer: NodeJS.Timeout | undefined;
  let writeSequence = Promise.resolve();

  const persist = async () => {
    if (!options.filePath) return;
    const filePath = options.filePath;
    const temporaryPath = `${filePath}.tmp`;
    const body = JSON.stringify({ version: 1, creators: Object.fromEntries(records) } satisfies StoredCreatorHistory, null, 2);
    writeSequence = writeSequence.then(async () => {
      mkdirSync(dirname(filePath), { recursive: true });
      await writeFile(temporaryPath, body, "utf8");
      await rename(temporaryPath, filePath);
    }).catch((error: unknown) => {
      options.logger.warn({ err: error, filePath }, "Unable to persist creator history");
    });
    await writeSequence;
  };

  const schedulePersist = () => {
    if (!options.filePath || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void persist();
    }, 1_000);
    saveTimer.unref();
  };

  const summarize = (record: CreatorRecord, currentTokenId: string): CreatorHistory => {
    const tokens = Object.values(record.tokens);
    const current = record.tokens[currentTokenId];
    const totalDuration = tokens.reduce((sum, token) => {
      const duration = Date.parse(token.lastSeenAt) - Date.parse(token.firstSeenAt);
      return sum + (Number.isFinite(duration) && duration >= 0 ? duration : 0);
    }, 0);
    return {
      creator: record.creator,
      coverageStartedAt: record.coverageStartedAt,
      observedLaunches: tokens.length,
      previousObservedLaunches: Math.max(0, tokens.length - 1),
      previousTokens: tokens
        .filter((token) => token.id !== currentTokenId)
        .sort((left, right) => Date.parse(right.firstSeenAt) - Date.parse(left.firstSeenAt))
        .slice(0, 5)
        .map((token) => ({
          address: token.address,
          ...(token.symbol ? { symbol: token.symbol } : {}),
          discoveredAt: token.firstSeenAt,
          reachedMeaningfulLiquidity: token.reachedMeaningfulLiquidity,
          lostNinetyPercent: token.lostNinetyPercent,
          severeLiquidityDrop: token.severeLiquidityDrop,
        })),
      meaningfulLiquidityUsd: threshold,
      reachedMeaningfulLiquidity: tokens.filter((token) => token.reachedMeaningfulLiquidity).length,
      lostNinetyPercent: tokens.filter((token) => token.lostNinetyPercent).length,
      severeLiquidityDrops: tokens.filter((token) => token.severeLiquidityDrop).length,
      ...(tokens.length > 0 ? { averageObservedDurationMs: totalDuration / tokens.length } : {}),
      ...(current?.lastCreatorHoldingPercent !== undefined
        ? { currentHoldingPercent: current.lastCreatorHoldingPercent }
        : {}),
      ...(current?.firstObservedSaleAt ? { firstObservedSaleAt: current.firstObservedSaleAt } : {}),
      ...(record.funding ? { funding: record.funding } : {}),
      warnings: [
        "History covers only launches and changes observed by this bot; it is not a complete on-chain backfill",
        "A 90% liquidity drop is an observed warning signal, not proof of a rug pull",
      ],
    };
  };

  return {
    async enrich(candidate) {
      if (!candidate.creator) return candidate;
      const key = recordKey(candidate.chain, candidate.creator);
      const observedAt = now().toISOString();
      const record = records.get(key) ?? {
        chain: candidate.chain,
        creator: candidate.creator,
        coverageStartedAt: observedAt,
        tokens: {},
      };
      const previous = record.tokens[candidate.id];
      const marketCap = finiteNonNegative(candidate.marketCapUsd);
      const liquidity = finiteNonNegative(candidate.liquidityUsd);
      const holding = creatorHolding(candidate);
      const firstSeenAt = previous?.firstSeenAt ?? candidate.discoveredAt.toISOString();
      const peakMarketCapUsd = Math.max(previous?.peakMarketCapUsd ?? 0, marketCap ?? 0);
      const peakLiquidityUsd = Math.max(previous?.peakLiquidityUsd ?? 0, liquidity ?? 0);
      const firstObservedSaleAt = previous?.firstObservedSaleAt ?? (
        previous?.lastCreatorHoldingPercent !== undefined && holding !== undefined &&
        holding < previous.lastCreatorHoldingPercent - 0.01
          ? observedAt
          : undefined
      );
      record.tokens[candidate.id] = {
        id: candidate.id,
        address: candidate.address,
        ...((candidate.symbol ?? candidate.name) ? { symbol: candidate.symbol ?? candidate.name } : {}),
        firstSeenAt,
        lastSeenAt: observedAt,
        ...(peakMarketCapUsd > 0 ? { peakMarketCapUsd } : {}),
        ...(marketCap !== undefined ? { currentMarketCapUsd: marketCap } : {}),
        ...(peakLiquidityUsd > 0 ? { peakLiquidityUsd } : {}),
        ...(liquidity !== undefined ? { currentLiquidityUsd: liquidity } : {}),
        ...(holding !== undefined ? { lastCreatorHoldingPercent: holding } :
          previous?.lastCreatorHoldingPercent !== undefined ? { lastCreatorHoldingPercent: previous.lastCreatorHoldingPercent } : {}),
        ...(firstObservedSaleAt ? { firstObservedSaleAt } : {}),
        reachedMeaningfulLiquidity: previous?.reachedMeaningfulLiquidity === true || (liquidity ?? 0) >= threshold,
        lostNinetyPercent: previous?.lostNinetyPercent === true ||
          (peakMarketCapUsd > 0 && marketCap !== undefined && marketCap <= peakMarketCapUsd * 0.1),
        severeLiquidityDrop: previous?.severeLiquidityDrop === true ||
          (peakLiquidityUsd > 0 && liquidity !== undefined && liquidity <= peakLiquidityUsd * 0.1),
      };
      records.set(key, record);

      if (candidate.chain === "solana" && options.fundingProvider && !record.funding && !fundingAttempts.has(key)) {
        fundingAttempts.add(key);
        try {
          const funding = await options.fundingProvider.lookup(candidate.creator);
          if (funding) record.funding = funding;
        } catch (error) {
          options.logger.debug({ err: error, creator: candidate.creator }, "Creator funding lookup unavailable");
        }
      }
      schedulePersist();
      return { ...candidate, creatorHistory: summarize(record, candidate.id) };
    },
    async flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
      }
      await persist();
    },
  };
}

export function createHeliusCreatorFundingProvider(apiKey: string, options: {
  fetch?: typeof fetch;
  timeoutMs?: number;
} = {}): CreatorFundingProvider {
  const fetcher = options.fetch ?? fetch;
  const cache = new Map<string, CreatorFunding | undefined>();
  return {
    async lookup(address) {
      if (cache.has(address)) return cache.get(address);
      const response = await fetcher(`https://api.helius.xyz/v1/wallet/${encodeURIComponent(address)}/funded-by`, {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(options.timeoutMs ?? 2_500),
      });
      if (response.status === 404) {
        cache.set(address, undefined);
        return undefined;
      }
      if (!response.ok) throw new Error(`Helius funded-by request failed with HTTP ${response.status}`);
      const data = await response.json() as Record<string, unknown>;
      const funder = typeof data.funder === "string"
        ? data.funder
        : typeof data.fundedBy === "string" ? data.fundedBy : undefined;
      if (!funder) {
        cache.set(address, undefined);
        return undefined;
      }
      const fundedAt = asIsoDate(data.fundedAt ?? data.timestamp);
      const amountValue = data.fundedAmount ?? data.amount;
      const funding: CreatorFunding = {
        address: funder,
        ...(typeof data.funderName === "string" ? { label: data.funderName } : {}),
        ...(typeof data.funderType === "string" ? { type: data.funderType } : {}),
        ...(typeof amountValue === "number" && Number.isFinite(amountValue) ? { amount: amountValue } : {}),
        ...(typeof data.symbol === "string" ? { symbol: data.symbol } : { symbol: "SOL" }),
        ...(fundedAt ? { fundedAt } : {}),
      };
      cache.set(address, funding);
      return funding;
    },
  };
}

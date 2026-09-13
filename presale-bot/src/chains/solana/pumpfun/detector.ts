import {
  PublicKey,
  type Commitment,
  type Connection,
  type Logs,
  type ParsedTransactionWithMeta,
  type AccountInfo,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { Logger } from "pino";
import type { ChainDetector } from "../../chain-detector.js";
import type { EventBus } from "../../../events/event-bus.js";
import { decodePumpBondingCurve, decodePumpCreateEventLog, decodePumpCreateInstruction, decodePumpTradeEventLog, type PumpCreation } from "./decoder.js";
import { normalizePumpCreation } from "./normalizer.js";
import { calculatePumpLiquidityAnalysis, calculatePumpMarketCapUsd, calculatePumpTokenPriceUsd, type SolUsdPriceService } from "./market-cap.js";
import type { TokenCandidate, TokenHolder } from "../../../domain/token-candidate.js";

const MAX_RECENT_SIGNATURES = 10_000;
const FETCH_ATTEMPTS = 6;
const CREATE_INSTRUCTION_LOG = /^Program log: Instruction: Create(?:V2)?$/;
const HOLDER_LOOKUP_INTERVAL_MS = 2_000;
const HOLDER_RATE_LIMIT_COOLDOWN_MS = 60_000;
const LEGACY_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export interface PumpDetectorStatus {
  running: boolean;
  subscriptionId?: number;
  lastEventAt?: Date;
  lastError?: string;
}

export class PumpFunDetector implements ChainDetector {
  private subscriptionId: number | undefined;
  private readonly completedSignatures = new Set<string>();
  private readonly inFlightSignatures = new Set<string>();
  private lastEventAt: Date | undefined;
  private lastError: string | undefined;
  private readonly trackedCandidates = new Map<string, { candidate: ReturnType<typeof normalizePumpCreation>; tokenTotalSupply?: bigint }>();
  private holderLookupInFlight = false;
  private nextHolderLookupAt = 0;

  constructor(
    private readonly dependencies: {
      connection: Pick<Connection, "onLogs" | "removeOnLogsListener" | "getParsedTransaction"> &
        Partial<Pick<Connection, "getAccountInfo" | "getProgramAccounts">>;
      programId: string;
      commitment: Commitment;
      eventBus: EventBus;
      logger: Logger;
      heliusApiKey?: string;
      solUsdPrice?: SolUsdPriceService;
    },
  ) {}

  status(): PumpDetectorStatus {
    return {
      running: this.subscriptionId !== undefined,
      ...(this.subscriptionId !== undefined ? { subscriptionId: this.subscriptionId } : {}),
      ...(this.lastEventAt ? { lastEventAt: this.lastEventAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async start(): Promise<void> {
    if (this.subscriptionId !== undefined) return;
    const programId = new PublicKey(this.dependencies.programId);
    this.subscriptionId = this.dependencies.connection.onLogs(
      programId,
      (logs, context) => {
        void this.processLogs(logs, context.slot).catch((error: unknown) => {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.dependencies.logger.error({ err: error, signature: logs.signature }, "Pump log processing failed");
        });
      },
      this.dependencies.commitment,
    );
    this.lastError = undefined;
    this.dependencies.logger.info(
      { programId: programId.toBase58(), subscriptionId: this.subscriptionId },
      "Pump.fun log detector started",
    );
  }

  async stop(): Promise<void> {
    if (this.subscriptionId === undefined) return;
    const subscriptionId = this.subscriptionId;
    this.subscriptionId = undefined;
    await this.dependencies.connection.removeOnLogsListener(subscriptionId);
    this.dependencies.logger.info({ subscriptionId }, "Pump.fun log detector stopped");
  }

  async processLogs(logs: Logs, slot: number, observedAt = new Date()): Promise<void> {
    if (logs.err || this.completedSignatures.has(logs.signature) || this.inFlightSignatures.has(logs.signature)) return;
    this.inFlightSignatures.add(logs.signature);
    try {
      const creationFromLog = logs.logs.map(decodePumpCreateEventLog).find((value) => value !== null);
      const tradeFromLog = logs.logs.map(decodePumpTradeEventLog).find((value) => value !== null);
      if (tradeFromLog) {
        const tracked = this.trackedCandidates.get(tradeFromLog.mint);
        if (!tracked) return;
        const marketData = await this.marketDataUsd(tradeFromLog, tracked.tokenTotalSupply);
        if (!marketData) return;
        const candidate = this.mergeMarketData(tracked.candidate, marketData);
        this.rememberCandidate(tradeFromLog.mint, { ...tracked, candidate });
        await this.dependencies.eventBus.emit({ type: "TokenMarketCapUpdated", candidate });
        this.lastEventAt = observedAt;
        this.rememberCompleted(logs.signature);
        return;
      }
      if (!creationFromLog && !logs.logs.some((log) => CREATE_INSTRUCTION_LOG.test(log))) return;
      const fetchedCreation = creationFromLog ? undefined : await this.fetchCreationInstruction(logs.signature);
      const decodedCreation = creationFromLog ?? fetchedCreation?.creation;
      if (!decodedCreation) return;
      const creation = await this.withBondingCurveReserves(decodedCreation);
      const normalized = normalizePumpCreation(creation, {
        signature: logs.signature,
        slot,
        observedAt,
        ...(fetchedCreation?.blockTime ? { chainTimestamp: fetchedCreation.blockTime } : {}),
      });
      const marketData = await this.marketDataUsd(creation, creation.tokenTotalSupply);
      const candidateWithMarketData = marketData ? this.mergeMarketData(normalized, marketData) : normalized;
      const candidateWithMintRisk = await this.withMintRiskData(candidateWithMarketData);
      const candidate = await this.withHolders(candidateWithMintRisk, creation.tokenTotalSupply);
      if (candidate.marketCapUsd === undefined) {
        this.dependencies.logger.warn(
          { mint: creation.mint, variant: creation.variant },
          "Pump.fun token market cap is unavailable",
        );
      }
      this.rememberCandidate(creation.mint, {
        candidate,
        ...(creation.tokenTotalSupply !== undefined ? { tokenTotalSupply: creation.tokenTotalSupply } : {}),
      });
      await this.dependencies.eventBus.emit({ type: "LaunchpadTokenCreated", candidate });
      if (candidate.tradable) await this.dependencies.eventBus.emit({ type: "TokenTradeable", candidate });
      this.lastEventAt = observedAt;
      this.rememberCompleted(logs.signature);
      this.dependencies.logger.info(
        { candidateId: candidate.id, mint: candidate.address, marketCapUsd: candidate.marketCapUsd, signature: logs.signature, slot },
        "Pump.fun token detected",
      );
    } finally {
      this.inFlightSignatures.delete(logs.signature);
    }
  }

  async refreshHolders(candidate: TokenCandidate): Promise<TokenCandidate> {
    if (candidate.chain !== "solana") return candidate;
    const rawSupply = candidate.metadata?.tokenTotalSupply;
    const tokenTotalSupply = typeof rawSupply === "string" && /^\d+$/.test(rawSupply) ? BigInt(rawSupply) : undefined;
    return this.withHolders(candidate, tokenTotalSupply);
  }

  async isTokenAvailable(candidate: TokenCandidate): Promise<boolean | undefined> {
    if (candidate.chain !== "solana") return undefined;
    if (typeof candidate.metadata?.mintAccountVerified === "boolean") {
      return candidate.metadata.mintAccountVerified;
    }
    const { getAccountInfo } = this.dependencies.connection;
    if (!getAccountInfo) return undefined;
    try {
      const account = await getAccountInfo.call(
        this.dependencies.connection,
        new PublicKey(candidate.address),
        {
          commitment: this.dependencies.commitment,
          ...(candidate.slot !== undefined ? { minContextSlot: candidate.slot } : {}),
        },
      );
      if (!account) return false;
      return candidate.tokenProgram === undefined || account.owner.toBase58() === candidate.tokenProgram;
    } catch (error) {
      this.dependencies.logger.debug({ err: error, mint: candidate.address }, "Unable to verify Solana mint availability");
      return undefined;
    }
  }

  private async withMintRiskData(candidate: TokenCandidate): Promise<TokenCandidate> {
    const { getAccountInfo } = this.dependencies.connection;
    if (!getAccountInfo) return candidate;
    try {
      const account = await getAccountInfo.call(
        this.dependencies.connection,
        new PublicKey(candidate.address),
        {
          commitment: this.dependencies.commitment,
          ...(candidate.slot !== undefined ? { minContextSlot: candidate.slot } : {}),
        },
      );
      if (!account) return {
        ...candidate,
        metadata: { ...candidate.metadata, mintAccountVerified: false },
      };
      const data = Buffer.from(account.data);
      const expectedProgram = candidate.tokenProgram;
      const ownerMatches = expectedProgram === undefined || account.owner.toBase58() === expectedProgram;
      const mintAuthority = this.cOptionPublicKey(data, 0);
      const freezeAuthority = this.cOptionPublicKey(data, 46);
      const initialized = data.length >= 82 && data[45] === 1;
      const verified = ownerMatches && initialized && mintAuthority !== undefined && freezeAuthority !== undefined;
      return {
        ...candidate,
        metadata: {
          ...candidate.metadata,
          mintAccountVerified: verified,
          ...(mintAuthority !== undefined ? { mintAuthority } : {}),
          ...(freezeAuthority !== undefined ? { freezeAuthority } : {}),
          mintAccountSize: data.length,
        },
      };
    } catch (error) {
      this.dependencies.logger.debug({ err: error, mint: candidate.address }, "Unable to read Solana mint risk data");
      return candidate;
    }
  }

  private cOptionPublicKey(data: Buffer, offset: number): string | null | undefined {
    if (data.length < offset + 36) return undefined;
    const option = data.readUInt32LE(offset);
    if (option === 0) return null;
    if (option !== 1) return undefined;
    return new PublicKey(data.subarray(offset + 4, offset + 36)).toBase58();
  }

  private async withBondingCurveReserves(creation: PumpCreation): Promise<PumpCreation> {
    if (creation.virtualTokenReserves !== undefined &&
      creation.virtualQuoteReserves !== undefined &&
      creation.tokenTotalSupply !== undefined) return creation;
    if (!this.dependencies.connection.getAccountInfo) return creation;
    try {
      const account = await this.dependencies.connection.getAccountInfo(
        new PublicKey(creation.bondingCurve),
        "confirmed",
      ) as AccountInfo<Buffer> | null;
      if (!account) return creation;
      const reserves = decodePumpBondingCurve(account.data);
      return { ...creation, ...reserves };
    } catch (error) {
      this.dependencies.logger.warn({ err: error, mint: creation.mint }, "Unable to read Pump.fun bonding curve reserves");
      return creation;
    }
  }

  private async marketDataUsd(
    reserves: Pick<PumpCreation, "virtualTokenReserves" | "virtualQuoteReserves">,
    tokenTotalSupply: bigint | undefined,
  ): Promise<{ marketCapUsd?: number; priceUsd?: number; liquidityUsd?: number; liquidityAnalysis?: TokenCandidate["liquidityAnalysis"] } | undefined> {
    if (!this.dependencies.solUsdPrice) return undefined;
    try {
      const solUsdPrice = await this.dependencies.solUsdPrice.currentPrice();
      const marketCapUsd = calculatePumpMarketCapUsd(reserves, tokenTotalSupply, solUsdPrice);
      const priceUsd = calculatePumpTokenPriceUsd(reserves, solUsdPrice);
      const liquidityAnalysis = calculatePumpLiquidityAnalysis(reserves, solUsdPrice, marketCapUsd);
      if (marketCapUsd === undefined && priceUsd === undefined && liquidityAnalysis === undefined) return undefined;
      return {
        ...(marketCapUsd !== undefined ? { marketCapUsd } : {}),
        ...(priceUsd !== undefined ? { priceUsd } : {}),
        ...(liquidityAnalysis !== undefined ? {
          liquidityUsd: liquidityAnalysis.effectiveLiquidityUsd,
          liquidityAnalysis,
        } : {}),
      };
    } catch (error) {
      this.dependencies.logger.warn({ err: error }, "Unable to calculate Pump.fun USD market cap");
      return undefined;
    }
  }

  private mergeMarketData(
    candidate: TokenCandidate,
    marketData: { marketCapUsd?: number; priceUsd?: number; liquidityUsd?: number; liquidityAnalysis?: TokenCandidate["liquidityAnalysis"] },
  ): TokenCandidate {
    return {
      ...candidate,
      ...(marketData.marketCapUsd !== undefined ? { marketCapUsd: marketData.marketCapUsd } : {}),
      ...(marketData.priceUsd !== undefined ? { priceUsd: marketData.priceUsd } : {}),
      ...(marketData.liquidityUsd !== undefined ? { liquidityUsd: marketData.liquidityUsd } : {}),
      ...(marketData.liquidityAnalysis !== undefined ? { liquidityAnalysis: marketData.liquidityAnalysis } : {}),
    };
  }

  private async withHolders(
    candidate: TokenCandidate,
    tokenTotalSupply: bigint | undefined,
  ): Promise<TokenCandidate> {
    if (this.holderLookupInFlight || Date.now() < this.nextHolderLookupAt) return candidate;
    this.holderLookupInFlight = true;
    try {
      if (this.dependencies.heliusApiKey) {
        try {
          const indexed = await this.indexedHolders(candidate, tokenTotalSupply, this.dependencies.heliusApiKey);
          if (indexed) return indexed;
        } catch (error) {
          this.dependencies.logger.warn({ err: error, mint: candidate.address }, "Indexed holder lookup failed; using Solana RPC fallback");
        }
      }
      const { getProgramAccounts } = this.dependencies.connection;
      if (!getProgramAccounts) return candidate;
      const tokenAccounts = await getProgramAccounts.call(
        this.dependencies.connection,
        new PublicKey(candidate.tokenProgram ?? LEGACY_TOKEN_PROGRAM_ID),
        {
          commitment: "confirmed",
          filters: [{ memcmp: { offset: 0, bytes: candidate.address } }],
          // SPL token account owner (32 bytes) followed by raw amount (u64).
          dataSlice: { offset: 32, length: 40 },
        },
      );
      const balancesByOwner = new Map<string, bigint>();
      tokenAccounts.forEach(({ account }) => {
        if (!Buffer.isBuffer(account.data) || account.data.length < 40) return;
        const owner = new PublicKey(account.data.subarray(0, 32)).toBase58();
        const amount = account.data.readBigUInt64LE(32);
        if (amount > 0n) balancesByOwner.set(owner, (balancesByOwner.get(owner) ?? 0n) + amount);
      });
      const ranked = [...balancesByOwner.entries()].sort(([, left], [, right]) => left > right ? -1 : left < right ? 1 : 0);
      const supply = tokenTotalSupply ? Number(tokenTotalSupply) / 10 ** (candidate.decimals ?? 0) : undefined;
      const holders = ranked.slice(0, 5).map(([address, rawBalance]) => {
        const balance = Number(rawBalance) / 10 ** (candidate.decimals ?? 0);
        return {
          address,
          balance,
          ...(supply && supply > 0 ? { percentage: balance / supply * 100 } : {}),
          ...(candidate.priceUsd !== undefined ? { valueUsd: balance * candidate.priceUsd } : {}),
        };
      });
      const creatorRawBalance = candidate.creator ? balancesByOwner.get(candidate.creator) ?? 0n : undefined;
      const creatorHoldingPercent = creatorRawBalance !== undefined && supply && supply > 0
        ? Number(creatorRawBalance) / 10 ** (candidate.decimals ?? 0) / supply * 100
        : undefined;
      return {
        ...candidate,
        holderCount: ranked.length,
        holders,
        ...(creatorHoldingPercent !== undefined
          ? { metadata: { ...candidate.metadata, creatorHoldingPercent } }
          : {}),
      };
    } catch (error) {
      const rateLimited = error instanceof Error && /(?:429|too many requests)/i.test(error.message);
      this.nextHolderLookupAt = Date.now() + (rateLimited ? HOLDER_RATE_LIMIT_COOLDOWN_MS : HOLDER_LOOKUP_INTERVAL_MS);
      this.dependencies.logger[rateLimited ? "warn" : "debug"](
        { err: error, mint: candidate.address, retryAfterMs: rateLimited ? HOLDER_RATE_LIMIT_COOLDOWN_MS : undefined },
        rateLimited ? "Solana holder lookup rate-limited; holder enrichment temporarily paused" : "Unable to read top token holders",
      );
      return candidate;
    } finally {
      this.holderLookupInFlight = false;
      if (this.nextHolderLookupAt < Date.now()) this.nextHolderLookupAt = Date.now() + HOLDER_LOOKUP_INTERVAL_MS;
    }
  }

  private async indexedHolders(
    candidate: TokenCandidate,
    tokenTotalSupply: bigint | undefined,
    apiKey: string,
  ): Promise<TokenCandidate | undefined> {
    const balancesByOwner = new Map<string, bigint>();
    const limit = 1_000;
    let page = 1;
    let reportedTotal: number | undefined;
    while (page <= 100) {
      const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `holders-${candidate.address}-${page}`,
          method: "getTokenAccounts",
          params: { mint: candidate.address, page, limit, options: { showZeroBalance: false } },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Helius holder request failed with HTTP ${response.status}`);
      const payload: unknown = await response.json();
      const result = typeof payload === "object" && payload !== null && "result" in payload
        ? (payload as { result?: unknown }).result
        : undefined;
      if (typeof result !== "object" || result === null) return undefined;
      const record = result as { total?: unknown; token_accounts?: unknown };
      if (typeof record.total === "number" && Number.isSafeInteger(record.total)) reportedTotal = record.total;
      if (!Array.isArray(record.token_accounts)) return undefined;
      for (const account of record.token_accounts) {
        if (typeof account !== "object" || account === null) continue;
        const item = account as { owner?: unknown; amount?: unknown };
        if (typeof item.owner !== "string") continue;
        const amount = this.rawTokenAmount(item.amount);
        if (amount > 0n) balancesByOwner.set(item.owner, (balancesByOwner.get(item.owner) ?? 0n) + amount);
      }
      if (record.token_accounts.length === 0 || (reportedTotal !== undefined && page * limit >= reportedTotal)) break;
      page += 1;
    }
    const ranked = [...balancesByOwner.entries()].sort(([, left], [, right]) => left > right ? -1 : left < right ? 1 : 0);
    const labels = await this.publicLabels(ranked.slice(0, 5).map(([address]) => address), apiKey);
    const supply = tokenTotalSupply ? Number(tokenTotalSupply) / 10 ** (candidate.decimals ?? 0) : undefined;
    const holders: TokenHolder[] = ranked.slice(0, 5).map(([address, rawBalance]) => {
      const balance = Number(rawBalance) / 10 ** (candidate.decimals ?? 0);
      const label = labels.get(address);
      return {
        address,
        ...(label ? { label } : {}),
        balance,
        ...(supply && supply > 0 ? { percentage: balance / supply * 100 } : {}),
        ...(candidate.priceUsd !== undefined ? { valueUsd: balance * candidate.priceUsd } : {}),
      };
    });
    const creatorRawBalance = candidate.creator ? balancesByOwner.get(candidate.creator) ?? 0n : undefined;
    const creatorHoldingPercent = creatorRawBalance !== undefined && supply && supply > 0
      ? Number(creatorRawBalance) / 10 ** (candidate.decimals ?? 0) / supply * 100
      : undefined;
    return {
      ...candidate,
      holderCount: ranked.length,
      holders,
      ...(creatorHoldingPercent !== undefined
        ? { metadata: { ...candidate.metadata, creatorHoldingPercent } }
        : {}),
    };
  }

  private rawTokenAmount(value: unknown): bigint {
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return BigInt(Math.trunc(value));
    return 0n;
  }

  private async publicLabels(addresses: readonly string[], apiKey: string): Promise<Map<string, string>> {
    if (addresses.length === 0) return new Map();
    try {
      const response = await fetch("https://api.helius.xyz/v1/wallet/batch-identity", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ addresses }),
        signal: AbortSignal.timeout(5_000),
      });
      // Identity lookup requires a paid plan. Holder data remains useful when
      // the key is free-tier or when a wallet has no known public identity.
      if (!response.ok) return new Map();
      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) return new Map();
      return new Map(payload.flatMap((identity) => {
        if (typeof identity !== "object" || identity === null) return [];
        const record = identity as { address?: unknown; name?: unknown; unresolved?: unknown };
        return typeof record.address === "string" && typeof record.name === "string" && record.unresolved !== true
          ? [[record.address, record.name] as const]
          : [];
      }));
    } catch {
      return new Map();
    }
  }

  private async fetchCreationInstruction(signature: string): Promise<{ creation: PumpCreation; blockTime?: Date } | null> {
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
      const transaction = await this.dependencies.connection.getParsedTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (transaction) {
        const creation = this.findCreationInstruction(transaction);
        if (!creation) return null;
        return {
          creation,
          ...(transaction.blockTime !== null && transaction.blockTime !== undefined
            ? { blockTime: new Date(transaction.blockTime * 1_000) }
            : {}),
        };
      }
      if (attempt < FETCH_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 200));
    }
    this.dependencies.logger.warn({ signature }, "Pump transaction was unavailable after bounded retries");
    return null;
  }

  private findCreationInstruction(transaction: ParsedTransactionWithMeta): PumpCreation | null {
    for (const instruction of transaction.transaction.message.instructions) {
      if (!("data" in instruction) || instruction.programId.toBase58() !== this.dependencies.programId) continue;
      const creation = decodePumpCreateInstruction(
        bs58.decode(instruction.data),
        instruction.accounts.map((account) => account.toBase58()),
      );
      if (creation) return creation;
    }
    return null;
  }

  private rememberCompleted(signature: string): void {
    this.completedSignatures.add(signature);
    if (this.completedSignatures.size <= MAX_RECENT_SIGNATURES) return;
    const oldest = this.completedSignatures.values().next().value;
    if (oldest !== undefined) this.completedSignatures.delete(oldest);
  }

  private rememberCandidate(
    mint: string,
    value: { candidate: ReturnType<typeof normalizePumpCreation>; tokenTotalSupply?: bigint },
  ): void {
    this.trackedCandidates.delete(mint);
    this.trackedCandidates.set(mint, value);
    if (this.trackedCandidates.size <= MAX_RECENT_SIGNATURES) return;
    const oldest = this.trackedCandidates.keys().next().value;
    if (oldest !== undefined) this.trackedCandidates.delete(oldest);
  }
}

import type { Logger } from "pino";
import { getAddress, parseAbi, type Address, type Hex } from "viem";
import type { EvmChainConfig, DexFactoryConfig } from "../../config/evm.js";
import type { TokenCandidate } from "../../domain/token-candidate.js";
import type { EventBus } from "../../events/event-bus.js";
import { liquidityToMarketCapPercent, priceImpactEstimates } from "../../liquidity/liquidity-analysis.js";
import type { ChainDetector } from "../chain-detector.js";
import { priceFromSqrtPriceX96, type NativeUsdPriceService } from "./market-data.js";

const V2_FACTORY_ABI = parseAbi([
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
]);
const V3_FACTORY_ABI = parseAbi([
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
]);
const V4_POOL_MANAGER_ABI = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);
const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const V2_PAIR_ABI = parseAbi([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);
const V3_POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

interface FactoryLog {
  args?: {
    token0?: Address;
    token1?: Address;
    currency0?: Address;
    currency1?: Address;
    pair?: Address;
    pool?: Address;
    id?: Hex;
    fee?: number;
    tickSpacing?: number;
    sqrtPriceX96?: bigint;
  };
  blockNumber?: bigint;
  transactionHash?: Hex;
  logIndex?: number;
}

export interface EvmDetectorClient {
  getChainId(): Promise<number>;
  watchContractEvent(parameters: {
    address: Address;
    abi: typeof V2_FACTORY_ABI | typeof V3_FACTORY_ABI | typeof V4_POOL_MANAGER_ABI;
    eventName: "PairCreated" | "PoolCreated" | "Initialize";
    onLogs(logs: readonly FactoryLog[]): void;
    onError(error: Error): void;
    pollingInterval: number;
    strict: true;
  }): () => void;
  readContract(parameters: {
    address: Address;
    abi: typeof ERC20_ABI | typeof V2_PAIR_ABI | typeof V3_POOL_ABI;
    functionName: "name" | "symbol" | "decimals" | "totalSupply" | "balanceOf" | "getReserves" | "slot0";
    args?: readonly [Address];
  }): Promise<unknown>;
  getBlock?(parameters: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  getTransaction?(parameters: { hash: Hex }): Promise<{ from: Address }>;
}

export interface EvmDetectorStatus {
  running: boolean;
  subscriptions: number;
  lastEventAt?: Date;
  lastError?: string;
}

export class EvmDexDetector implements ChainDetector {
  private unwatchers: Array<() => void> = [];
  private readonly completedEvents = new Set<string>();
  private readonly inFlightEvents = new Set<string>();
  private lastEventAt: Date | undefined;
  private lastError: string | undefined;

  constructor(private readonly dependencies: {
    config: EvmChainConfig;
    client: EvmDetectorClient;
    eventBus: EventBus;
    logger: Logger;
    nativeUsdPrice?: NativeUsdPriceService;
  }) {}

  status(): EvmDetectorStatus {
    return {
      running: this.unwatchers.length > 0,
      subscriptions: this.unwatchers.length,
      ...(this.lastEventAt ? { lastEventAt: this.lastEventAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async start(): Promise<void> {
    if (this.unwatchers.length > 0) return;
    const actualChainId = await this.dependencies.client.getChainId();
    if (actualChainId !== this.dependencies.config.id) {
      throw new Error(`RPC chain ID ${actualChainId} does not match configured ${this.dependencies.config.id}`);
    }
    this.unwatchers = this.dependencies.config.dexFactories.map((factory) => this.watchFactory(factory));
    this.lastError = undefined;
    this.dependencies.logger.info({
      chain: this.dependencies.config.key,
      chainId: actualChainId,
      factories: this.dependencies.config.dexFactories.length,
    }, "EVM DEX detector started");
  }

  async stop(): Promise<void> {
    this.unwatchers.splice(0).forEach((unwatch) => unwatch());
    this.dependencies.logger.info({ chain: this.dependencies.config.key }, "EVM DEX detector stopped");
  }

  async refreshHolders(candidate: TokenCandidate): Promise<TokenCandidate> {
    if (candidate.chain !== this.dependencies.config.key || candidate.decimals === undefined || !candidate.poolAddress) return candidate;
    const rawSupply = candidate.metadata?.totalSupply;
    if (typeof rawSupply !== "string" || !/^\d+$/.test(rawSupply)) return candidate;
    const transactionHash = candidate.metadata?.transactionHash;
    try {
      const creator = candidate.creator
        ? getAddress(candidate.creator)
        : typeof transactionHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(transactionHash)
          ? await this.poolCreator(transactionHash as Hex)
          : undefined;
      const holders = await this.knownHolders(
        getAddress(candidate.address),
        getAddress(candidate.poolAddress),
        candidate.decimals,
        BigInt(rawSupply),
        candidate.priceUsd,
        creator,
      );
      return { ...candidate, ...(creator ? { creator } : {}), holders };
    } catch (error) {
      this.dependencies.logger.debug({ err: error, token: candidate.address }, "Unable to refresh EVM holders");
      return candidate;
    }
  }

  isTokenAvailable(candidate: TokenCandidate): boolean | undefined {
    if (candidate.chain !== this.dependencies.config.key) return undefined;
    const totalSupply = candidate.metadata?.totalSupply;
    return candidate.decimals !== undefined &&
      typeof candidate.symbol === "string" && candidate.symbol.trim().length > 0 &&
      typeof totalSupply === "string" && /^\d+$/.test(totalSupply) && BigInt(totalSupply) > 0n;
  }

  private watchFactory(factory: DexFactoryConfig): () => void {
    const event = factory.type === "v2"
      ? { abi: V2_FACTORY_ABI, eventName: "PairCreated" as const }
      : factory.type === "v3"
        ? { abi: V3_FACTORY_ABI, eventName: "PoolCreated" as const }
        : { abi: V4_POOL_MANAGER_ABI, eventName: "Initialize" as const };
    return this.dependencies.client.watchContractEvent({
      address: getAddress(factory.address),
      ...event,
      strict: true,
      pollingInterval: this.dependencies.config.pollingIntervalMs,
      onLogs: (logs) => {
        void this.processLogs(factory, logs).catch((error: unknown) => this.recordError(error, factory));
      },
      onError: (error) => this.recordError(error, factory),
    });
  }

  private async processLogs(factory: DexFactoryConfig, logs: readonly FactoryLog[]): Promise<void> {
    for (const log of logs) {
      const token0 = log.args?.token0 ?? log.args?.currency0;
      const token1 = log.args?.token1 ?? log.args?.currency1;
      const pool = factory.type === "v2"
        ? log.args?.pair
        : factory.type === "v3"
          ? log.args?.pool
          : getAddress(factory.address);
      if (!token0 || !token1 || !pool) continue;
      const eventId = `${log.transactionHash ?? "unknown"}:${log.logIndex ?? 0}`;
      if (this.completedEvents.has(eventId) || this.inFlightEvents.has(eventId)) continue;
      this.inFlightEvents.add(eventId);
      try {
        const candidate = await this.normalizePool(factory, token0, token1, pool, log);
        this.rememberCompleted(eventId);
        if (!candidate) continue;
        await this.dependencies.eventBus.emit({ type: "PoolCreated", candidate });
        this.lastEventAt = candidate.discoveredAt;
        this.dependencies.logger.info({
          chain: candidate.chain,
          token: candidate.address,
          pool: candidate.poolAddress,
          factory: factory.name,
          transactionHash: log.transactionHash,
        }, "EVM DEX pool detected");
      } finally {
        this.inFlightEvents.delete(eventId);
      }
    }
  }

  private async normalizePool(
    factory: DexFactoryConfig,
    token0: Address,
    token1: Address,
    pool: Address,
    log: FactoryLog,
  ): Promise<TokenCandidate | undefined> {
    const quotes = new Set(this.dependencies.config.quoteTokens.map((address) => address.toLowerCase()));
    const token0IsQuote = quotes.has(token0.toLowerCase());
    const token1IsQuote = quotes.has(token1.toLowerCase());
    if (token0IsQuote === token1IsQuote) return undefined;
    const address = getAddress(token0IsQuote ? token1 : token0);
    const quoteToken = getAddress(token0IsQuote ? token0 : token1);
    const [name, symbol, decimals, totalSupply, quoteDecimals] = await Promise.all([
      this.safeRead(address, "name"),
      this.safeRead(address, "symbol"),
      this.safeRead(address, "decimals"),
      this.safeRead(address, "totalSupply"),
      this.safeRead(quoteToken, "decimals"),
    ]);
    if (typeof symbol !== "string" || symbol.trim().length === 0 ||
      typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 255 ||
      typeof totalSupply !== "bigint" || totalSupply <= 0n) {
      this.dependencies.logger.info({ address, factory: factory.name }, "Pool token ignored because ERC-20 metadata is invalid");
      return undefined;
    }
    const discoveredAt = await this.blockTime(log.blockNumber);
    const [marketData, creator] = await Promise.all([
      typeof quoteDecimals === "number"
        ? this.marketData(factory, pool, token0IsQuote, decimals, quoteDecimals, totalSupply, quoteToken, log)
        : undefined,
      log.transactionHash ? this.poolCreator(log.transactionHash) : undefined,
    ]);
    const holders = await this.knownHolders(address, pool, decimals, totalSupply, marketData?.priceUsd, creator);
    return {
      id: `${this.dependencies.config.key}:${address.toLowerCase()}`,
      chain: this.dependencies.config.key,
      source: "dex-pool",
      address,
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof symbol === "string" ? { symbol } : {}),
      ...(typeof decimals === "number" ? { decimals } : {}),
      ...(creator ? { creator } : {}),
      quoteToken,
      poolAddress: getAddress(pool),
      discoveredAt,
      ...marketData,
      ...(holders?.length ? { holders } : {}),
      fomoListed: false,
      // Factory creation alone does not prove that liquidity has been added.
      tradable: false,
      metadata: {
        factory: getAddress(factory.address),
        factoryName: factory.name,
        factoryType: factory.type,
        ...(log.args?.id ? { poolId: log.args.id } : {}),
        blockNumber: log.blockNumber?.toString(),
        transactionHash: log.transactionHash,
        totalSupply: typeof totalSupply === "bigint" ? totalSupply.toString() : undefined,
        fee: log.args?.fee,
        tickSpacing: log.args?.tickSpacing,
      },
    };
  }

  private async safeRead(address: Address, functionName: "name" | "symbol" | "decimals" | "totalSupply"): Promise<unknown> {
    try {
      return await this.dependencies.client.readContract({ address, abi: ERC20_ABI, functionName });
    } catch (error) {
      this.dependencies.logger.debug({ err: error, address, functionName }, "ERC-20 metadata read failed");
      return undefined;
    }
  }

  private async blockTime(blockNumber: bigint | undefined): Promise<Date> {
    if (blockNumber === undefined || !this.dependencies.client.getBlock) return new Date();
    try {
      const block = await this.dependencies.client.getBlock({ blockNumber });
      return new Date(Number(block.timestamp) * 1_000);
    } catch (error) {
      this.dependencies.logger.debug({ err: error, blockNumber }, "Unable to read EVM block timestamp");
      return new Date();
    }
  }

  private async marketData(
    factory: DexFactoryConfig,
    pool: Address,
    token0IsQuote: boolean,
    candidateDecimals: number,
    quoteDecimals: number,
    totalSupply: bigint,
    quoteToken: Address,
    log: FactoryLog,
  ): Promise<{
    priceUsd: number;
    marketCapUsd: number;
    liquidityUsd?: number;
    liquidityAnalysis: NonNullable<TokenCandidate["liquidityAnalysis"]>;
  } | undefined> {
    try {
      let quotePerToken: number | undefined;
      let candidateReserve: number | undefined;
      let quoteReserve: number | undefined;
      if (factory.type === "v2") {
        const reserves = await this.dependencies.client.readContract({
          address: getAddress(pool), abi: V2_PAIR_ABI, functionName: "getReserves",
        });
        if (Array.isArray(reserves) && typeof reserves[0] === "bigint" && typeof reserves[1] === "bigint") {
          candidateReserve = Number(token0IsQuote ? reserves[1] : reserves[0]) / 10 ** candidateDecimals;
          quoteReserve = Number(token0IsQuote ? reserves[0] : reserves[1]) / 10 ** quoteDecimals;
          if (candidateReserve > 0 && quoteReserve > 0) quotePerToken = quoteReserve / candidateReserve;
        }
      } else {
        let sqrtPriceX96 = log.args?.sqrtPriceX96;
        if (factory.type === "v3") {
          const slot0 = await this.dependencies.client.readContract({
            address: getAddress(pool), abi: V3_POOL_ABI, functionName: "slot0",
          });
          if (Array.isArray(slot0) && typeof slot0[0] === "bigint") sqrtPriceX96 = slot0[0];
        }
        if (sqrtPriceX96 !== undefined) {
          quotePerToken = priceFromSqrtPriceX96(
            sqrtPriceX96,
            !token0IsQuote,
            candidateDecimals,
            quoteDecimals,
          );
        }
      }
      if (quotePerToken === undefined) return undefined;
      const quoteUsd = await this.quoteUsdPrice(quoteToken);
      if (quoteUsd === undefined) return undefined;
      const priceUsd = quotePerToken * quoteUsd;
      const supply = Number(totalSupply) / 10 ** candidateDecimals;
      const marketCapUsd = priceUsd * supply;
      if (!Number.isFinite(priceUsd) || priceUsd <= 0 || !Number.isFinite(marketCapUsd) || marketCapUsd < 0) return undefined;
      const isStableQuote = this.dependencies.config.usdStableTokens.some((token) =>
        token.toLowerCase() === quoteToken.toLowerCase());
      const quoteSymbol = isStableQuote ? "USD stable" : this.dependencies.config.nativeSymbol;
      if (factory.type === "v2" && candidateReserve !== undefined && quoteReserve !== undefined) {
        const liquidityUsd = quoteReserve * quoteUsd * 2;
        const ratio = liquidityToMarketCapPercent(liquidityUsd, marketCapUsd);
        const swapFeeRate = factory.swapFeeRate ?? 0.003;
        const swapFeePercent = (swapFeeRate * 100).toFixed(2);
        return {
          priceUsd,
          marketCapUsd,
          liquidityUsd,
          liquidityAnalysis: {
            venueType: "V2_AMM",
            effectiveLiquidityUsd: liquidityUsd,
            tokenReserve: candidateReserve,
            quoteReserve,
            quoteSymbol,
            ...(ratio !== undefined ? { liquidityToMarketCapPercent: ratio } : {}),
            priceImpactEstimates: priceImpactEstimates(quoteReserve, quoteUsd, swapFeeRate),
            controlStatus: "UNVERIFIED",
            controlDescription: "LP-token ownership, locking, and burn status have not been inspected",
            warnings: [
              `Price-impact estimates assume a ${swapFeePercent}% V2 fee and exclude token taxes, gas, MEV, and later state changes`,
              "Liquidity can be removable until LP ownership and locking are verified",
            ],
          },
        };
      }
      return {
        priceUsd,
        marketCapUsd,
        liquidityAnalysis: {
          venueType: "CONCENTRATED_LIQUIDITY",
          quoteSymbol,
          controlStatus: "UNVERIFIED",
          controlDescription: "Position ownership and removable in-range liquidity have not been inspected",
          warnings: [
            "V3/V4 price impact requires a live quoter or swap simulation and is currently unavailable",
            "A spot sqrt price does not prove usable in-range liquidity",
          ],
        },
      };
    } catch (error) {
      this.dependencies.logger.debug({ err: error, pool, factory: factory.name }, "EVM token valuation unavailable");
      return undefined;
    }
  }

  private async quoteUsdPrice(quoteToken: Address): Promise<number | undefined> {
    const normalized = quoteToken.toLowerCase();
    if (this.dependencies.config.usdStableTokens.some((token) => token.toLowerCase() === normalized)) return 1;
    if (this.dependencies.config.wrappedNativeToken?.toLowerCase() !== normalized) return undefined;
    try {
      return await this.dependencies.nativeUsdPrice?.currentPrice();
    } catch (error) {
      this.dependencies.logger.debug({ err: error }, "Native-token USD price unavailable");
      return undefined;
    }
  }

  private async knownHolders(
    token: Address,
    pool: Address,
    decimals: number,
    totalSupply: bigint,
    priceUsd: number | undefined,
    creator: Address | undefined,
  ) {
    const addresses = new Set<Address>([getAddress(pool)]);
    if (creator) addresses.add(creator);
    const balances = await Promise.all([...addresses].map(async (holder) => {
      try {
        const raw = await this.dependencies.client.readContract({
          address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [holder],
        });
        if (typeof raw !== "bigint" || raw <= 0n) return undefined;
        const balance = Number(raw) / 10 ** decimals;
        return {
          address: holder,
          balance,
          ...(totalSupply > 0n ? { percentage: Number(raw) / Number(totalSupply) * 100 } : {}),
          ...(priceUsd !== undefined ? { valueUsd: balance * priceUsd } : {}),
        };
      } catch {
        return undefined;
      }
    }));
    return balances.filter((holder) => holder !== undefined).sort((a, b) => b.balance - a.balance).slice(0, 5);
  }

  private async poolCreator(transactionHash: Hex): Promise<Address | undefined> {
    if (!this.dependencies.client.getTransaction) return undefined;
    try {
      return getAddress((await this.dependencies.client.getTransaction({ hash: transactionHash })).from);
    } catch (error) {
      this.dependencies.logger.debug({ err: error, transactionHash }, "Unable to read pool creator");
      return undefined;
    }
  }

  private recordError(error: unknown, factory: DexFactoryConfig): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.dependencies.logger.error({ err: error, chain: this.dependencies.config.key, factory: factory.name }, "EVM factory listener failed");
  }

  private rememberCompleted(eventId: string): void {
    this.completedEvents.add(eventId);
    if (this.completedEvents.size <= 10_000) return;
    const oldest = this.completedEvents.values().next().value;
    if (oldest !== undefined) this.completedEvents.delete(oldest);
  }
}

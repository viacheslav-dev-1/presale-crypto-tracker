export const CHAINS = ["solana", "bsc", "base", "robinhood"] as const;

export type Chain = (typeof CHAINS)[number];

export type DiscoverySource =
  | "spl-mint"
  | "pumpfun"
  | "raydium"
  | "dex-pool"
  | "contract-deployment";

export interface TokenHolder {
  /** Wallet address when resolvable; otherwise the chain token-account address. */
  address: string;
  balance: number;
  percentage?: number;
  valueUsd?: number;
  /** Public identity/domain label supplied by an external indexer. */
  label?: string;
}

export type RiskLevel = "LOWER" | "MODERATE" | "ELEVATED" | "HIGH" | "EXTREME";
export type RiskConfidence = "LOW" | "MEDIUM" | "HIGH";

export interface RiskAssessment {
  status: "ASSESSED" | "INSUFFICIENT_DATA";
  level: RiskLevel;
  confidence: RiskConfidence;
  /** Concrete observations that affected, or materially reduced, the score. */
  factors: readonly string[];
  /** Important checks that could not be completed with the available data. */
  missingChecks: readonly string[];
}

export interface PriceImpactEstimate {
  tradeUsd: number;
  impactPercent: number;
}

export interface LiquidityAnalysis {
  venueType: "BONDING_CURVE" | "V2_AMM" | "CONCENTRATED_LIQUIDITY";
  effectiveLiquidityUsd?: number;
  tokenReserve?: number;
  quoteReserve?: number;
  quoteSymbol?: string;
  liquidityToMarketCapPercent?: number;
  priceImpactEstimates?: readonly PriceImpactEstimate[];
  controlStatus: "PROGRAM_CONTROLLED" | "UNVERIFIED";
  controlDescription: string;
  warnings: readonly string[];
}

export interface CreatorFunding {
  address: string;
  label?: string;
  type?: string;
  amount?: number;
  symbol?: string;
  fundedAt?: string;
}

export interface CreatorPreviousToken {
  address: string;
  symbol?: string;
  discoveredAt: string;
  reachedMeaningfulLiquidity: boolean;
  lostNinetyPercent: boolean;
  severeLiquidityDrop: boolean;
}

export interface CreatorHistory {
  creator: string;
  /** Earliest local observation retained for this creator. */
  coverageStartedAt: string;
  observedLaunches: number;
  previousObservedLaunches: number;
  previousTokens: readonly CreatorPreviousToken[];
  meaningfulLiquidityUsd: number;
  reachedMeaningfulLiquidity: number;
  lostNinetyPercent: number;
  severeLiquidityDrops: number;
  averageObservedDurationMs?: number;
  currentHoldingPercent?: number;
  firstObservedSaleAt?: string;
  funding?: CreatorFunding;
  warnings: readonly string[];
}

export interface TokenCandidate {
  id: string;
  chain: Chain;
  source: DiscoverySource;
  address: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  creator?: string;
  creatorHistory?: CreatorHistory;
  /** Shared executable token program on Solana (SPL Token or Token-2022). */
  tokenProgram?: string;
  quoteToken?: string;
  poolAddress?: string;
  slot?: number;
  signature?: string;
  discoveredAt: Date;
  tradeableAt?: Date;
  liquidityUsd?: number;
  liquidityAnalysis?: LiquidityAnalysis;
  marketCapUsd?: number;
  priceUsd?: number;
  holders?: readonly TokenHolder[];
  /** Exact non-zero wallet count when the data source can enumerate all holders. */
  holderCount?: number;
  fomoListed: boolean;
  fomoListedAt?: Date;
  riskScore?: number;
  riskAssessment?: RiskAssessment;
  tradable?: boolean;
  metadata?: Record<string, unknown>;
}

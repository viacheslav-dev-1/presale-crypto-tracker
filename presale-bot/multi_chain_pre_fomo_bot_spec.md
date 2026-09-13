# Multi-Chain Pre-FOMO Token Discovery & Trading Bot
## Node.js / TypeScript / Telegram — Implementation Specification

> **Purpose:** Build a Telegram bot that detects newly tradeable tokens directly on-chain before they appear on FOMO, validates them, optionally allows manual buying, and later supports tightly controlled automatic execution.
>
> **Primary networks:** Solana, BSC, Base, Robinhood Chain.
>
> **Special protocol:** Pump.fun runs on **Solana** and must be implemented as a Solana launch-protocol adapter, not as a separate blockchain.

---

# 1. Objective

The system must discover tokens from blockchain activity rather than depending on FOMO as the discovery source.

The intended sequence is:

```text
Token/Pool Created On-Chain
        ↓
Bot Detects It
        ↓
Normalize Token Candidate
        ↓
Validate Tradability + Risk
        ↓
Check Whether FOMO Already Lists It
        ↓
Notify Telegram
        ↓
Optional Manual Buy
        ↓
Optional Future Auto-Buy
        ↓
Track Position / Sell
```

The bot should answer this measurable question:

> **How much earlier did the bot detect a token becoming tradeable compared with the time it appeared on FOMO?**

The MVP should prioritize reliable measurement and discovery before automatic trading.

---

# 2. Important Design Principles

## 2.1 FOMO is not the discovery source

FOMO should be treated as a **comparison/listing provider**, not as the source of truth for finding new contracts.

Primary discovery sources are:

- Solana on-chain program logs
- Pump.fun creation / bonding-curve events
- Raydium pool initialization
- SPL token mint creation
- EVM smart-contract deployments
- EVM DEX factory `PairCreated` / `PoolCreated` events

---

## 2.2 "New token" and "tradeable token" are different states

A token contract or SPL mint may exist without any market or liquidity.

Use at least two separate lifecycle events:

```ts
TokenDiscovered
TokenTradeable
```

Example:

```text
17:20:00.124 SPL mint created
17:20:03.481 Pump bonding curve or DEX pool becomes active
17:20:05.927 Token becomes visible on FOMO
```

Meaning:

```text
Discovery lead over FOMO = 5.803 sec
Tradeable lead over FOMO = 2.446 sec
```

The **tradeable lead** is the more important metric.

---

## 2.3 Pump.fun is part of Solana

Do not implement Pump.fun as another blockchain.

Correct structure:

```text
Solana
 ├── SPL Mint Detector
 ├── Pump.fun Detector
 ├── Pump.fun Trader
 ├── Raydium Detector
 └── Raydium Trader
```

---

## 2.4 BNB, Base, and Robinhood should share one EVM infrastructure

Implement a generic EVM adapter and configure it for different chains.

```text
EVM Adapter
 ├── BSC
 ├── Base
 └── Robinhood Chain
```

Do not duplicate three complete implementations.

---

## 2.5 Do not auto-buy on raw contract creation

A raw contract deployment is only an early signal.

The normal auto-trade trigger should be one of:

- active Pump.fun bonding curve
- newly initialized Raydium pool
- newly initialized EVM DEX pair/pool
- another verified launchpad / liquidity venue

---

# 3. Technology Stack

Use:

```text
Runtime:          Node.js 22+
Language:         TypeScript
Telegram:         grammY
Solana:           @solana/web3.js
SPL:              @solana/spl-token
Pump.fun:         official/current Pump SDKs where practical
EVM:              viem
Database:         PostgreSQL
ORM:              Prisma
Queue / cache:    Redis + BullMQ
Logging:          pino
Validation:       zod
Testing:          Vitest
Containerization: Docker
```

Optional later:

```text
Metrics:          Prometheus
Dashboards:       Grafana
Tracing:          OpenTelemetry
```

Do not hardcode unstable protocol addresses or RPC endpoints directly in business logic.

---

# 4. High-Level Architecture

```text
                    ┌────────────────────┐
                    │   Telegram Bot     │
                    │       grammY       │
                    └─────────┬──────────┘
                              │
                    Commands / Callbacks
                              │
                    ┌─────────▼──────────┐
                    │    Bot Core        │
                    │ Strategy Manager   │
                    └─────────┬──────────┘
                              │
          ┌───────────────────┼───────────────────────┐
          │                   │                       │
┌─────────▼────────┐ ┌────────▼────────┐ ┌───────────▼──────────┐
│ Solana Adapter   │ │ EVM Adapter     │ │ FOMO Listing Watcher │
│                  │ │                 │ │                      │
│ SPL              │ │ BNB             │ │ presence / timestamp │
│ Pump.fun         │ │ Base            │ └──────────────────────┘
│ Raydium          │ │ Robinhood       │
└─────────┬────────┘ └────────┬────────┘
          │                   │
          └─────────┬─────────┘
                    ▼
          ┌───────────────────┐
          │ Token Normalizer  │
          └─────────┬─────────┘
                    ▼
          ┌───────────────────┐
          │ Validation / Risk │
          └─────────┬─────────┘
                    ▼
          ┌───────────────────┐
          │ Strategy Engine   │
          └─────────┬─────────┘
                    │
          ┌─────────▼─────────┐
          │ Execution Engine  │
          └─────────┬─────────┘
                    ▼
          ┌───────────────────┐
          │ Wallet / Signer   │
          └───────────────────┘
```

---

# 5. Monorepo / Project Structure

Recommended structure:

```text
src/
 ├── bot/
 │    ├── bot.ts
 │    ├── middleware/
 │    ├── commands/
 │    ├── callbacks/
 │    ├── keyboards/
 │    └── notifications/
 │
 ├── chains/
 │    ├── solana/
 │    │    ├── connection.ts
 │    │    ├── subscriptions.ts
 │    │    ├── mint-detector.ts
 │    │    ├── token-utils.ts
 │    │    ├── pumpfun/
 │    │    │    ├── detector.ts
 │    │    │    ├── decoder.ts
 │    │    │    ├── validator.ts
 │    │    │    └── trader.ts
 │    │    ├── raydium/
 │    │    │    ├── detector.ts
 │    │    │    ├── decoder.ts
 │    │    │    └── trader.ts
 │    │    └── solana-trader.ts
 │    │
 │    └── evm/
 │         ├── client.ts
 │         ├── detector.ts
 │         ├── contract-detector.ts
 │         ├── pool-detector.ts
 │         ├── erc20.ts
 │         ├── trader.ts
 │         ├── simulation.ts
 │         ├── factories/
 │         │    ├── v2-factory.ts
 │         │    └── v3-factory.ts
 │         └── chains/
 │              ├── bsc.ts
 │              ├── base.ts
 │              └── robinhood.ts
 │
 ├── discovery/
 │    ├── event-bus.ts
 │    ├── candidate-service.ts
 │    ├── normalizer.ts
 │    ├── deduplicator.ts
 │    └── timestamps.ts
 │
 ├── validation/
 │    ├── risk-engine.ts
 │    ├── liquidity.ts
 │    ├── solana-validator.ts
 │    ├── evm-validator.ts
 │    ├── blacklist.ts
 │    └── scoring.ts
 │
 ├── strategy/
 │    ├── strategy-engine.ts
 │    ├── rules.ts
 │    ├── filters.ts
 │    └── limits.ts
 │
 ├── trading/
 │    ├── execution-engine.ts
 │    ├── position-manager.ts
 │    ├── slippage.ts
 │    ├── quote.ts
 │    ├── transaction-status.ts
 │    └── pnl.ts
 │
 ├── fomo/
 │    ├── provider.ts
 │    ├── watcher.ts
 │    ├── matcher.ts
 │    └── metrics.ts
 │
 ├── wallets/
 │    ├── signer.ts
 │    ├── solana-wallet.ts
 │    ├── evm-wallet.ts
 │    ├── encryption.ts
 │    └── limits.ts
 │
 ├── database/
 │    ├── prisma.ts
 │    ├── repositories/
 │    └── migrations/
 │
 ├── queue/
 │    ├── redis.ts
 │    ├── queues.ts
 │    └── workers/
 │
 ├── config/
 │    ├── env.ts
 │    ├── chains.ts
 │    ├── dexes.ts
 │    ├── programs.ts
 │    └── strategy.ts
 │
 ├── monitoring/
 │    ├── logger.ts
 │    ├── metrics.ts
 │    └── health.ts
 │
 ├── shared/
 │    ├── types.ts
 │    ├── errors.ts
 │    ├── result.ts
 │    └── time.ts
 │
 └── index.ts
```

---

# 6. Core Domain Model

Use one normalized object across all chains.

```ts
export type Chain =
  | "solana"
  | "bsc"
  | "base"
  | "robinhood";

export type DiscoverySource =
  | "spl-mint"
  | "pumpfun"
  | "raydium"
  | "dex-pool"
  | "contract-deployment";

export interface TokenCandidate {
  id: string;

  chain: Chain;
  source: DiscoverySource;

  address: string;

  name?: string;
  symbol?: string;
  decimals?: number;

  creator?: string;

  quoteToken?: string;
  poolAddress?: string;

  blockNumber?: bigint;
  blockHash?: string;

  slot?: number;
  signature?: string;
  transactionHash?: string;

  discoveredAt: Date;
  tradeableAt?: Date;

  liquidityUsd?: number;
  liquidityNative?: bigint;

  fomoListed: boolean;
  fomoListedAt?: Date;

  riskScore?: number;
  tradable?: boolean;

  metadata?: Record<string, unknown>;
}
```

---

# 7. Event System

Do not directly couple chain listeners to Telegram or trading.

Use an internal event bus.

```ts
export type BotEvent =
  | { type: "TokenContractCreated"; candidate: TokenCandidate }
  | { type: "TokenMintCreated"; candidate: TokenCandidate }
  | { type: "LaunchpadTokenCreated"; candidate: TokenCandidate }
  | { type: "PoolCreated"; candidate: TokenCandidate }
  | { type: "TokenTradeable"; candidate: TokenCandidate }
  | { type: "CandidateAccepted"; candidate: TokenCandidate }
  | { type: "CandidateRejected"; candidate: TokenCandidate; reason: string }
  | { type: "BuyRequested"; candidateId: string; amount: bigint }
  | { type: "BuySubmitted"; candidateId: string; txId: string }
  | { type: "BuyConfirmed"; candidateId: string; txId: string }
  | { type: "BuyFailed"; candidateId: string; error: string }
  | { type: "SellRequested"; positionId: string }
  | { type: "SellConfirmed"; positionId: string; txId: string }
  | { type: "FomoListingDetected"; candidateId: string; listedAt: Date };
```

Example flow:

```text
PumpDetector
    ↓
EventBus
    ↓
CandidateService
    ↓
RiskEngine
    ↓
StrategyEngine
    ├────────────→ TelegramNotifier
    ↓
ExecutionEngine
```

---

# 8. Solana Adapter

## 8.1 Solana RPC

Support both:

```text
HTTP RPC
WebSocket RPC
```

Configuration:

```env
SOLANA_RPC_HTTP=
SOLANA_RPC_WS=
SOLANA_COMMITMENT=processed
```

Use the lowest-latency commitment where appropriate for discovery, but handle dropped/reorged transactions and later confirmation.

---

# 9. SPL Mint Detector

Listen for token mint initialization activity from:

```text
SPL Token Program
Token-2022 Program
```

Detect operations equivalent to:

```text
InitializeMint
InitializeMint2
```

On detection extract:

```text
mint address
mint authority
freeze authority
decimals
transaction signature
slot
timestamp
token program
```

Create:

```text
TokenDiscovered
```

Do **not** immediately mark as tradeable.

Purpose:

- earliest possible discovery signal
- track mint age
- correlate later pool / launchpad creation
- measure timeline

---

# 10. Pump.fun Detector

Pump.fun should be treated as a Solana launch protocol.

Subscribe to the currently valid Pump program(s).

**Important:** program IDs and SDK behavior can change. At implementation time, verify all program IDs against official/current Pump.fun documentation or repositories and load them from configuration.

Example:

```env
PUMPFUN_PROGRAM_ID=
```

Use Solana log subscriptions:

```ts
connection.onLogs(
  pumpProgramPublicKey,
  onPumpTransaction,
  "processed",
);
```

For relevant transactions:

```text
Pump instruction
       ↓
decode creation event/instruction
       ↓
extract mint
       ↓
extract creator
       ↓
extract bonding curve
       ↓
extract metadata URI/name/symbol when available
       ↓
create TokenCandidate
```

Expected extracted fields:

```text
mint
creator
bonding curve
associated bonding curve
name
symbol
URI
signature
slot
detected timestamp
```

Emit:

```text
LaunchpadTokenCreated
```

If the bonding curve can already accept buys:

```text
TokenTradeable
```

---

# 11. Pump.fun Trading

The trader must determine whether the token is:

```text
A. still on Pump.fun bonding curve
B. migrated / graduated to AMM
```

Flow:

```text
Pump Token
    ↓
inspect current state
    ↓
┌────────────────────┬───────────────────────┐
│ bonding curve      │ migrated / graduated │
│                    │                       │
│ execute Pump buy   │ execute AMM swap      │
└────────────────────┴───────────────────────┘
```

Use the current supported Pump SDK/API where practical.

Do not assume one SDK or instruction set is permanent.

---

# 12. Raydium Detector

Implement dedicated adapters for the Raydium programs you decide to support.

At minimum consider:

```text
CPMM
CLMM
legacy / AMM variants if still relevant
```

Program IDs must be configuration-driven.

Listen for pool initialization and decode:

```text
pool address
token mint A
token mint B
vault A
vault B
initial liquidity
transaction signature
slot
```

Determine the likely new token by comparing both pool tokens against trusted quote tokens.

Example trusted quotes:

```text
SOL
USDC
USDT
```

Example:

```text
NEWTOKEN / SOL
      ↓
candidate = NEWTOKEN
quote = SOL
```

Emit:

```text
PoolCreated
TokenTradeable
```

---

# 13. Solana Validation

For each candidate check:

```text
mint authority
freeze authority
token program
Token-2022 extensions
transfer-fee configuration
transfer hooks
metadata
creator
supply
largest holders
pool liquidity
pool authority
tradability
simulation where possible
```

Flag unusual Token-2022 behavior.

Validation output:

```ts
export interface ValidationResult {
  accepted: boolean;
  riskScore: number; // 0 = lower observed risk, 100 = highest observed risk
  reasons: string[];
  warnings: string[];
}
```

Do not represent `riskScore` as a guarantee of safety.

---

# 14. Generic EVM Adapter

BSC, Base, and Robinhood Chain must use shared EVM code.

Example config:

```ts
export interface EvmChainConfig {
  id: number;
  key: "bsc" | "base" | "robinhood";
  name: string;

  httpRpcUrl: string;
  wsRpcUrl: string;

  nativeSymbol: string;

  quoteTokens: `0x${string}`[];
  dexFactories: DexFactoryConfig[];
}
```

Example:

```ts
const client = createPublicClient({
  chain: chainDefinition,
  transport: webSocket(config.wsRpcUrl),
});
```

Chain IDs, RPC URLs, canonical wrapped-native addresses, and deployed DEX factory addresses must be verified against current official sources at implementation time.

---

# 15. EVM Contract Deployment Detector

Watch new blocks and/or relevant transaction feeds.

Contract creation usually has:

```ts
tx.to === null
```

After receipt:

```text
receipt.contractAddress
```

Probe whether it behaves like an ERC-20:

```solidity
name()
symbol()
decimals()
totalSupply()
balanceOf(address)
```

Possible result:

```text
new contract
    ↓
ERC-20-like behavior
    ↓
TokenDiscovered
```

Do **not** auto-buy because a contract was deployed.

This detector is primarily useful for:

- measuring contract age
- linking later liquidity creation
- creator analysis
- discovering suspicious deployment patterns

---

# 16. EVM DEX Pool Detector

This is the primary EVM tradability signal.

Support at least two factory types.

## V2-style

Listen for:

```solidity
event PairCreated(
    address indexed token0,
    address indexed token1,
    address pair,
    uint256
);
```

## V3-style

Listen for:

```solidity
event PoolCreated(
    address indexed token0,
    address indexed token1,
    uint24 fee,
    int24 tickSpacing,
    address pool
);
```

Flow:

```text
Factory event
    ↓
decode token0 / token1 / pair or pool
    ↓
classify trusted quote token
    ↓
identify unknown/new token
    ↓
load token metadata
    ↓
measure initial liquidity
    ↓
simulate swap
    ↓
TokenTradeable
```

---

# 17. Chain-Specific EVM Configuration

## 17.1 BSC

Support configured DEX factories, starting with major venues relevant to newly launched tokens.

Expected trusted quotes may include:

```text
WBNB
USDT
USDC
```

Do not hardcode old factory addresses from memory. Verify them before deploying.

---

## 17.2 Base

Support major Base DEX factories relevant to token launches.

Expected trusted quotes may include:

```text
WETH
USDC
```

### Optional latency optimization

If Base exposes a current pre-confirmation / Flashblocks subscription mechanism appropriate for production, implement it behind an interface such as:

```ts
interface FastBlockFeed {
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

Do not make the core system depend on experimental infrastructure.

---

## 17.3 Robinhood Chain

Treat Robinhood Chain as EVM-compatible infrastructure.

Reuse:

```text
EVM client
contract detector
DEX factory detector
ERC-20 validator
execution engine
```

Chain-specific configuration includes:

```text
chain ID
RPC
wrapped native asset
supported DEX factories
quote tokens
router addresses
gas strategy
```

Because ecosystem deployments can change, require verified configuration before enabling trading.

---

# 18. DEX Factory Configuration

Use configuration rather than code changes.

```ts
export interface DexFactoryConfig {
  name: string;

  factoryAddress: `0x${string}`;

  type: "v2" | "v3";

  eventAbi: readonly unknown[];

  routerAddress?: `0x${string}`;
}
```

Example config file:

```ts
export const baseFactories: DexFactoryConfig[] = [
  // verified addresses go here
];
```

---

# 19. Candidate Deduplication

The same token can be detected multiple ways:

```text
contract deployment
mint creation
Pump launch
Raydium pool
DEX V2 pool
DEX V3 pool
```

Deduplicate by:

```text
chain + token address
```

Maintain multiple observations:

```ts
interface CandidateObservation {
  candidateId: string;
  source: DiscoverySource;
  observedAt: Date;
  transactionId?: string;
  poolAddress?: string;
  metadata?: Record<string, unknown>;
}
```

Never discard the first-seen timestamp.

---

# 20. Tradability Engine

Implement:

```ts
interface TradabilityChecker {
  check(candidate: TokenCandidate): Promise<TradabilityResult>;
}
```

Result:

```ts
interface TradabilityResult {
  tradeable: boolean;
  venue?: string;
  quoteToken?: string;
  poolAddress?: string;
  estimatedLiquidityUsd?: number;
  reason?: string;
}
```

Examples:

```text
Pump.fun bonding curve can accept buys
Raydium pool contains usable liquidity
Uniswap-style pool has usable reserves/liquidity
```

---

# 21. Risk / Validation Engine

Do not assume that a newly tradeable token is safe.

Pipeline:

```text
TokenCandidate
      │
      ├── metadata validation
      ├── contract/mint validation
      ├── creator analysis
      ├── liquidity validation
      ├── authority validation
      ├── buy simulation
      ├── sell simulation
      ├── transfer restriction analysis
      ├── concentration analysis
      └── configurable rules
              ↓
         PASS / REJECT
```

---

# 22. EVM Risk Checks

At minimum consider:

```text
can buy?
can sell?
buy tax
sell tax
transfer tax
owner permissions
proxy / upgradeability
blacklist capabilities
whitelist requirements
max wallet
max transaction
pause / freeze controls
mint capability
trading enable flags
liquidity amount
liquidity concentration
owner concentration
creator concentration
router compatibility
simulation success
```

A simulation failure should normally block auto-buy.

---

# 23. Solana Risk Checks

At minimum:

```text
mint authority
freeze authority
Token-2022 extensions
transfer fee
transfer hook
metadata mutability
creator holdings
top holder concentration
initial liquidity
pool state
swap simulation
bonding-curve state
```

---

# 24. Risk Score

Suggested semantics:

```text
0-20   lower observed risk
21-40  moderate
41-60  elevated
61-80  high
81-100 extreme
```

This score is a heuristic, not a guarantee.

Suggested auto-buy policy:

```text
AUTO_BUY_MAX_RISK_SCORE=25
```

Do not enable auto-buy by default.

---

# 25. FOMO Listing Provider

Define an abstraction:

```ts
export interface ListingInfo {
  listed: boolean;
  listedAt?: Date;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface ListingProvider {
  findToken(
    chain: Chain,
    address: string,
  ): Promise<ListingInfo | null>;
}
```

Implementation:

```ts
class FomoListingProvider implements ListingProvider {}
```

Purpose:

```text
candidate detected
      ↓
check FOMO
      ↓
listed?
 ┌────┴─────┐
 NO         YES
 ↓           ↓
pre-FOMO     store FOMO timestamp
candidate
```

Do not build core functionality around undocumented private FOMO endpoints.

If no stable listing interface is available:

- make FOMO checking optional
- keep discovery fully functional
- isolate FOMO code in its own adapter
- never couple trading execution to FOMO availability

---

# 26. Measuring Lead Time

Store:

```text
firstDetectedAt
tradeableAt
fomoListedAt
```

Compute:

```ts
discoveryLeadMs =
  fomoListedAt.getTime() - firstDetectedAt.getTime();

tradeableLeadMs =
  fomoListedAt.getTime() - tradeableAt.getTime();
```

Telegram example:

```text
On-chain discovery: 17:20:00.124
Tradeable:           17:20:03.481
FOMO detected:       17:20:05.927

Discovery lead:      5.803 sec
Tradeable lead:      2.446 sec
```

Use millisecond precision throughout the backend.

For chains that expose higher-resolution event timing, preserve both chain metadata and local receive time.

---

# 27. Strategy Engine

The strategy engine must not be embedded inside chain adapters.

Example interface:

```ts
interface StrategyDecision {
  action: "ignore" | "notify" | "manual-buy-enabled" | "auto-buy";
  reason: string;
  maxAmount?: bigint;
}

interface StrategyEngine {
  evaluate(
    candidate: TokenCandidate,
    validation: ValidationResult,
  ): Promise<StrategyDecision>;
}
```

Example rules:

```text
tradable == true
riskScore <= threshold
liquidity >= minimum
chain enabled
source enabled
token not blacklisted
creator not blacklisted
daily loss limit not exceeded
daily spending limit not exceeded
open position limit not exceeded
FOMO-listed condition matches selected strategy
```

---

# 28. Trading Modes

Support three explicit modes:

```text
DISCOVERY_ONLY
MANUAL_BUY
AUTO_BUY
```

Default:

```text
DISCOVERY_ONLY
```

## DISCOVERY_ONLY

- detect
- validate
- store
- notify
- never sign transactions

## MANUAL_BUY

- Telegram buttons allow execution
- user chooses amount
- backend revalidates immediately before submitting

## AUTO_BUY

- only after explicit configuration
- strict risk and spending limits
- perform a final just-in-time validation
- log every rule used in the decision

---

# 29. Trading Engine

Define chain-agnostic interface:

```ts
export interface BuyRequest {
  chain: Chain;
  tokenAddress: string;
  amountIn: bigint;
  maxSlippageBps: number;
}

export interface TradeResult {
  submitted: boolean;
  txId?: string;
  error?: string;
}

export interface Trader {
  buy(request: BuyRequest): Promise<TradeResult>;
}
```

Adapters:

```text
PumpFunTrader
RaydiumTrader
EvmDexTrader
```

---

# 30. Pre-Trade Revalidation

Immediately before signing:

```text
1. confirm token still tradeable
2. reload pool/bonding-curve state
3. refresh quote
4. validate slippage
5. simulate transaction where possible
6. confirm risk constraints
7. confirm wallet limits
8. confirm chain health
9. sign
10. submit
```

Do not rely exclusively on state captured several seconds earlier.

---

# 31. Slippage

Use basis points.

```ts
const BPS = 10_000;

interface SlippagePolicy {
  defaultBps: number;
  maxBps: number;
}
```

Example:

```text
default  = 500 bps = 5%
maximum  = configurable
```

Never silently increase above configured maximum.

---

# 32. Wallet Architecture

Preferred architecture:

```text
Discovery Service
      ↓
Strategy Service
      ↓
Execution Service
      ↓
Signing Service
```

The signing component should expose narrow methods:

```ts
interface Signer {
  signSolanaTransaction(...): Promise<...>;
  signEvmTransaction(...): Promise<...>;
}
```

Avoid putting unrestricted private keys directly inside Telegram command handlers.

---

# 33. Wallet Safety Limits

Configurable limits:

```text
max amount per trade
max amount per chain
max daily spending
max daily loss
max open positions
allowed chains
allowed routers
allowed protocols
max slippage
max risk score
```

Example:

```env
MAX_TRADE_USD=50
MAX_DAILY_SPEND_USD=250
MAX_DAILY_LOSS_USD=100
MAX_OPEN_POSITIONS=5
MAX_SLIPPAGE_BPS=1000
AUTO_BUY_MAX_RISK_SCORE=25
```

---

# 34. Key Storage

Development:

```text
encrypted local secret
small test wallet
very low balance
```

Production:

```text
dedicated signing service
secret manager / KMS-style storage
access control
withdrawal restrictions where possible
separate hot wallet
small operational balance
```

Do not commit secrets to git.

---

# 35. Telegram Bot Commands

Recommended commands:

```text
/start
/help
/status

/chains
/enable_solana
/enable_bsc
/enable_base
/enable_robinhood

/sources
/detections
/recent

/filters
/liquidity
/risk

/mode
/autobuy
/pause

/wallets
/balance

/positions
/pnl

/settings
/health
```

---

# 36. Telegram Candidate Notification

Solana / Pump example:

```text
🚨 PRE-FOMO TOKEN

Chain: Solana
Source: Pump.fun

Token: ABC
Mint: 7xab...pump

Detected: 142 ms ago
Tradeable: ✅
FOMO: ❌ Not listed

Liquidity/Bonding Curve: ✅
Mint Authority: [result]
Freeze Authority: [result]

Risk: 21/100

[BUY 0.1 SOL]
[BUY 0.5 SOL]
[DETAILS]
[IGNORE]
```

EVM example:

```text
🚨 NEW POOL

Chain: Base
DEX: <venue>

Token: TEST
Contract: 0x812...

Pair: TEST/WETH
Initial Liquidity: ~$18,420

Contract Age: 1.4 sec
FOMO: ❌ Not detected
Risk: 28/100

[BUY $25]
[BUY $50]
[DETAILS]
[IGNORE]
```

---

# 37. Telegram Controls

Use inline keyboards.

Examples:

```text
[Enable Solana ✅]
[Enable BSC ✅]
[Enable Base ✅]
[Enable Robinhood ❌]

[Discovery Only]
[Manual Buy]
[Auto Buy]

[Pause Trading]
[Resume Trading]
```

For dangerous actions, require confirmation:

```text
ENABLE AUTO BUY?

Max Trade: $25
Max Daily Spend: $100
Risk <= 20
Chains: Solana, Base

[CONFIRM]
[CANCEL]
```

---

# 38. Database Model

Suggested entities:

```text
Token
TokenObservation
Pool
ValidationResult
FomoListing
Trade
Position
Wallet
StrategyConfig
ChainConfig
ProtocolConfig
BotUser
AuditLog
```

Example Prisma-style concept:

```prisma
model Token {
  id            String   @id
  chain         String
  address       String
  name          String?
  symbol        String?
  decimals      Int?

  firstSeenAt   DateTime
  tradeableAt   DateTime?
  fomoListedAt  DateTime?

  riskScore     Int?
  tradable      Boolean  @default(false)

  observations TokenObservation[]

  @@unique([chain, address])
}
```

---

# 39. Audit Logging

Every trade decision must be reconstructable.

Store:

```text
candidate
validation inputs
risk score
strategy rules
quote
slippage
simulation result
wallet limit state
transaction payload hash
transaction ID
submission timestamp
confirmation timestamp
failure reason
```

For auto-buy:

```text
Why did the bot buy this?
```

must always be answerable from logs.

---

# 40. Redis / Queue Design

Recommended queues:

```text
discovery-events
token-validation
fomo-check
trade-execution
transaction-confirmation
position-monitor
telegram-notifications
```

Benefits:

- isolate slow validation from event ingestion
- avoid blocking websocket listeners
- retries
- backpressure
- easier horizontal scaling

---

# 41. WebSocket Reliability

All chain subscriptions must support:

```text
automatic reconnect
exponential backoff
subscription restoration
heartbeat / stale connection detection
duplicate event handling
last processed block/slot tracking
catch-up after reconnect
```

Do not assume a WebSocket will remain connected permanently.

---

# 42. Reorg / Finality Handling

Discovery should be fast but later confirmed.

Store statuses:

```text
SEEN
CONFIRMED
FINALIZED
DROPPED
```

Solana:

```text
processed
confirmed
finalized
```

EVM:

```text
pending / observed
included
N confirmations
```

If an early event disappears:

```text
mark observation DROPPED
do not delete historical data
```

---

# 43. Retry Strategy

Different classes of errors:

```text
network error       → retry
rate limit          → delayed retry
simulation revert   → normally reject
invalid token       → no retry
insufficient funds  → stop execution
nonce conflict      → refresh + retry safely
blockhash expired   → rebuild transaction
```

Avoid blind transaction resubmission that could cause duplicated buys.

---

# 44. Observability

Log structured JSON.

Example:

```json
{
  "event": "token_tradeable",
  "chain": "solana",
  "source": "pumpfun",
  "token": "...",
  "latencyMs": 182,
  "riskScore": 18
}
```

Metrics:

```text
tokens_detected_total
tokens_tradeable_total
pre_fomo_tokens_total
fomo_lead_ms
validation_duration_ms
buy_submission_ms
trade_success_total
trade_failure_total
rpc_reconnect_total
rpc_latency_ms
```

---

# 45. Health Endpoint

Expose:

```text
GET /health
GET /ready
GET /metrics
```

Health should report:

```text
database
redis
solana RPC
solana websocket
BSC websocket
Base websocket
Robinhood websocket
Telegram
FOMO watcher
```

---

# 46. Configuration

Example `.env.example`:

```env
NODE_ENV=development

TELEGRAM_BOT_TOKEN=

DATABASE_URL=
REDIS_URL=

SOLANA_RPC_HTTP=
SOLANA_RPC_WS=
SOLANA_COMMITMENT=processed

BSC_RPC_HTTP=
BSC_RPC_WS=

BASE_RPC_HTTP=
BASE_RPC_WS=

ROBINHOOD_RPC_HTTP=
ROBINHOOD_RPC_WS=

PUMPFUN_PROGRAM_ID=

ENABLED_CHAINS=solana,bsc,base,robinhood

BOT_MODE=DISCOVERY_ONLY

MIN_LIQUIDITY_USD=5000
MAX_RISK_SCORE=40

MAX_TRADE_USD=25
MAX_DAILY_SPEND_USD=100
MAX_DAILY_LOSS_USD=50
MAX_OPEN_POSITIONS=3

DEFAULT_SLIPPAGE_BPS=500
MAX_SLIPPAGE_BPS=1000

AUTO_BUY_ENABLED=false
AUTO_BUY_MAX_RISK_SCORE=20

LOG_LEVEL=info
```

Never put actual private keys in `.env.example`.

---

# 47. Configuration Validation

Use Zod at startup.

Example:

```ts
const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().min(1),

  BOT_MODE: z.enum([
    "DISCOVERY_ONLY",
    "MANUAL_BUY",
    "AUTO_BUY",
  ]),

  AUTO_BUY_ENABLED: z.coerce.boolean().default(false),
});
```

Fail fast on invalid production configuration.

---

# 48. Security Rules

Mandatory:

```text
never expose private keys through Telegram
never log private keys
never log seed phrases
never allow arbitrary destination transfers from Telegram
never accept arbitrary transaction calldata from users
never auto-enable new router addresses
never auto-enable new chain IDs
```

Telegram user IDs allowed to control trading must be whitelisted.

Example:

```env
TELEGRAM_ADMIN_IDS=123456789
```

---

# 49. Development Phases

## Phase 0 — Foundation

Implement:

```text
TypeScript project
config validation
logging
PostgreSQL
Prisma
Redis
BullMQ
Telegram bot
health endpoint
```

Acceptance:

```text
/start works
/status works
DB is reachable
Redis is reachable
health endpoint reports dependencies
```

---

## Phase 1 — Pump.fun Discovery

Implement:

```text
Solana WS connection
Pump log subscription
Pump transaction decoding
TokenCandidate creation
database persistence
Telegram notification
```

No buying.

Acceptance:

```text
new Pump token is detected
mint is extracted
firstSeenAt is stored
duplicate events do not duplicate token
notification appears in Telegram
```

---

## Phase 2 — Solana Pool Discovery

Implement:

```text
SPL mint detector
Raydium pool detector
quote token classification
tradability state
```

Acceptance:

```text
mint creation can be correlated with later pool creation
TokenDiscovered and TokenTradeable timestamps are separate
```

---

## Phase 3 — Generic EVM Infrastructure

Implement:

```text
viem clients
WS reconnect
block listener
contract deployment detector
ERC-20 probing
generic DEX factory listener
```

Acceptance:

```text
same code runs for multiple configured EVM chains
```

---

## Phase 4 — BNB / Base / Robinhood

Configure:

```text
RPC endpoints
chain IDs
wrapped-native token
stable quote tokens
verified DEX factories
routers
```

Acceptance:

```text
pool creation events produce normalized TokenCandidate objects
```

---

## Phase 5 — FOMO Comparison

Implement:

```text
ListingProvider abstraction
FomoListingProvider
poll/check queue
timestamp persistence
lead time calculation
Telegram updates
```

Acceptance:

```text
bot can show:
firstSeenAt
tradeableAt
fomoListedAt
discoveryLeadMs
tradeableLeadMs
```

---

## Phase 6 — Validation Engine

Implement:

```text
Solana validation
EVM validation
risk scoring
buy simulation
sell simulation where possible
liquidity thresholds
```

Acceptance:

```text
every candidate receives:
risk score
warnings
accepted/rejected state
```

---

## Phase 7 — Manual Trading

Implement:

```text
wallet system
signer abstraction
buy buttons
Pump.fun buy
Raydium swap
EVM DEX swap
confirmation monitoring
position creation
```

Acceptance:

```text
user taps BUY
bot revalidates candidate
bot requests confirmation if configured
transaction executes
Telegram shows tx status
position is stored
```

---

## Phase 8 — Position Management

Implement:

```text
balance tracking
current quote
PnL
manual sell
partial sell
position close
```

Telegram:

```text
/positions
/pnl
```

---

## Phase 9 — Auto-Buy

Only implement after enough discovery statistics exist.

Requirements:

```text
explicit enable
per-trade cap
daily cap
daily loss cap
risk threshold
liquidity threshold
source allowlist
chain allowlist
router allowlist
final simulation
emergency pause
```

Acceptance:

```text
auto-buy cannot exceed any configured limit
every decision is logged
/pause stops new automatic trades immediately
```

---

# 50. Recommended Priority

Build in this order:

```text
1. Pump.fun
2. Solana / Raydium
3. Base
4. BSC
5. Robinhood Chain
```

Reason:

```text
Pump.fun provides a strong Solana launch event
Raydium covers post-launch liquidity
Base has active EVM token-launch activity
BNB has a large token ecosystem
Robinhood can reuse the generic EVM stack
```

This order is for engineering efficiency, not an investment recommendation.

---

# 51. MVP Definition

The MVP should **not auto-buy**.

The first complete MVP should:

```text
watch all enabled chains
detect token/mint creation
detect actual tradability
normalize candidates
validate basic risk
store precise timestamps
check FOMO
calculate lead time
send Telegram notification
```

Example MVP Telegram output:

```text
🚨 TOKEN DETECTED

Chain: Solana
Source: Pump.fun

Symbol: ABC
Mint: ...

First Seen: 17:20:00.124
Tradeable: 17:20:00.391
FOMO: Not listed

Observed Risk: 18/100
Liquidity: <value>

Lead vs FOMO: pending
```

Later:

```text
✅ FOMO LISTING DETECTED

ABC

First Seen:   17:20:00.124
Tradeable:    17:20:00.391
FOMO Listed:  17:20:02.830

Discovery Lead: 2.706 sec
Tradeable Lead: 2.439 sec
```

---

# 52. Why the MVP Comes Before Auto-Buy

Before real capital is used, collect enough data to answer:

```text
Which source is earliest?
Which signal actually predicts FOMO listings?
How often are detected tokens never listed?
What is median lead time?
What is p50 / p90 / p99 lead time?
How frequently is liquidity removed quickly?
What percentage fail buy/sell simulation?
Which chains produce the best signal quality?
```

Suggested report:

```text
Source        Detections   FOMO Listed   Median Lead
Pump.fun      ...
Raydium       ...
Base pools    ...
BSC pools     ...
Robinhood     ...
```

Only use auto-buy after real data demonstrates that the selected trigger has a usable advantage.

---

# 53. Performance Targets

Initial targets:

```text
WebSocket event → internal event:       < 50 ms local processing
Event → persisted candidate:            < 100 ms
Event → basic Telegram notification:    < 500 ms
Event → basic validation:               < 1 sec where feasible
```

Do not delay first notification waiting for slow metadata providers.

Telegram can first send:

```text
NEW TOKEN DETECTED
```

then edit/update the message after validation.

---

# 54. Fast Path vs Slow Path

Use two processing lanes.

## Fast Path

```text
on-chain event
    ↓
decode
    ↓
identify token
    ↓
deduplicate
    ↓
persist first-seen timestamp
    ↓
basic Telegram alert
```

## Slow Path

```text
metadata
risk checks
holder analysis
FOMO check
liquidity analysis
simulation
```

This prevents slow APIs from destroying the latency advantage.

---

# 55. Metadata Providers

Metadata enrichment should be optional and asynchronous.

Potential metadata:

```text
name
symbol
image
website
social links
creator
supply
holders
market info
```

Never block detection on token image/social metadata.

---

# 56. RPC Strategy

For production:

```text
primary RPC
secondary/fallback RPC
WebSocket endpoint
HTTP endpoint
```

Optional configuration:

```env
SOLANA_RPC_HTTP_PRIMARY=
SOLANA_RPC_HTTP_FALLBACK=

BASE_RPC_WS_PRIMARY=
BASE_RPC_WS_FALLBACK=
```

Failover should not duplicate events because deduplication is database-backed.

---

# 57. Testing Strategy

## Unit tests

Test:

```text
event decoding
candidate normalization
quote token identification
risk scoring
strategy rules
lead-time calculation
slippage
configuration validation
```

## Integration tests

Test:

```text
Solana RPC mock / devnet where relevant
EVM local Anvil node
factory event decoding
swap simulation
database persistence
BullMQ workers
Telegram handlers
```

## Replay tests

Store real historical transaction/event fixtures.

Replay:

```text
Pump transaction
Raydium pool creation
V2 PairCreated
V3 PoolCreated
```

This allows testing without waiting for live token launches.

---

# 58. EVM Local Testing

Use:

```text
Anvil
```

Deploy:

```text
mock ERC-20
mock V2 factory
mock pair
test router
```

Simulate:

```text
deploy token
create pair
add liquidity
emit PairCreated
bot detects
bot validates
manual buy
```

---

# 59. Solana Testing

Use fixtures for transaction decoding.

Where feasible:

```text
local validator
devnet
recorded mainnet transaction responses
```

Do not make unit tests depend on live mainnet RPC.

---

# 60. Failure Scenarios to Test

Mandatory:

```text
WebSocket disconnect
duplicate event
malformed token metadata
RPC timeout
FOMO unavailable
database unavailable
Redis unavailable
token disappears after early observation
pool created with zero liquidity
honeypot-style EVM token
buy succeeds / sell fails simulation
insufficient wallet balance
expired Solana blockhash
EVM nonce conflict
transaction dropped
high slippage
Telegram API failure
```

---

# 61. CI

Pipeline:

```text
npm ci
npm run lint
npm run typecheck
npm test
npm run build
docker build
```

No deployment if:

```text
tests fail
types fail
lint fails
security secret scan fails
```

---

# 62. Docker

Services:

```text
bot
postgres
redis
```

Optional:

```text
prometheus
grafana
```

Example:

```text
docker-compose.yml
```

should be included for local development.

---

# 63. Suggested NPM Scripts

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev"
  }
}
```

---

# 64. Coding Conventions

Use:

```text
strict TypeScript
no `any` unless justified
dependency injection for RPC/services
small adapters
pure functions for scoring
Result-style error handling for expected failures
AbortSignal/timeouts for network requests
structured logging
```

Do not:

```text
put RPC logic inside Telegram handlers
put Telegram logic inside blockchain listeners
hardcode secrets
hardcode unstable protocol addresses
swallow RPC exceptions
perform unbounded retries
```

---

# 65. Interfaces to Implement First

```ts
interface ChainDetector {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface CandidateRepository {
  upsertCandidate(candidate: TokenCandidate): Promise<TokenCandidate>;
}

interface CandidateValidator {
  validate(candidate: TokenCandidate): Promise<ValidationResult>;
}

interface ListingProvider {
  findToken(
    chain: Chain,
    address: string,
  ): Promise<ListingInfo | null>;
}

interface Trader {
  buy(request: BuyRequest): Promise<TradeResult>;
}

interface TelegramNotifier {
  candidateDetected(candidate: TokenCandidate): Promise<void>;
  candidateUpdated(candidate: TokenCandidate): Promise<void>;
  tradeUpdated(...args: unknown[]): Promise<void>;
}
```

---

# 66. Main Runtime

Conceptual boot sequence:

```ts
async function main() {
  const config = loadConfig();

  await database.connect();
  await redis.connect();

  const eventBus = createEventBus();

  registerCandidatePipeline(eventBus);
  registerValidationPipeline(eventBus);
  registerFomoPipeline(eventBus);
  registerTelegramPipeline(eventBus);

  if (config.chains.solana.enabled) {
    await solanaDetector.start();
  }

  if (config.chains.bsc.enabled) {
    await bscDetector.start();
  }

  if (config.chains.base.enabled) {
    await baseDetector.start();
  }

  if (config.chains.robinhood.enabled) {
    await robinhoodDetector.start();
  }

  await telegramBot.start();
}
```

---

# 67. Critical Rule for Coding Agent

When implementing chain/protocol constants:

> **Never trust addresses copied from this specification without verification.**

Before adding any of the following:

```text
program ID
factory address
router address
wrapped native token address
chain ID
RPC URL
event ABI
Pump.fun instruction layout
Raydium program layout
```

the implementation agent must verify the value against the current official protocol/network documentation.

Place verified values in:

```text
src/config/chains.ts
src/config/dexes.ts
src/config/programs.ts
```

and add a comment with the source and verification date.

---

# 68. Out of Scope for the First MVP

Do not implement initially:

```text
fully autonomous high-frequency trading
copy trading
front-running
MEV bundle infrastructure
arbitrary smart-contract execution
unrestricted wallet transfers
multi-user custody
complex leverage
derivatives
```

Focus first on:

```text
discovery
measurement
validation
manual execution
```

---

# 69. Recommended Delivery Milestones

## Milestone A

```text
Telegram + DB + Redis + architecture
```

## Milestone B

```text
Pump.fun live discovery
```

## Milestone C

```text
Raydium + SPL detection
```

## Milestone D

```text
Generic EVM listener
```

## Milestone E

```text
BNB + Base + Robinhood adapters
```

## Milestone F

```text
FOMO matcher + lead metrics
```

## Milestone G

```text
risk validation
```

## Milestone H

```text
manual buys and sells
```

## Milestone I

```text
position management
```

## Milestone J

```text
optional constrained auto-buy
```

---

# 70. Definition of Done

The project is considered functionally complete when:

- [ ] Telegram bot runs reliably.
- [ ] Solana WebSocket subscriptions reconnect automatically.
- [ ] Pump.fun launches are detected.
- [ ] SPL mint events can be recorded.
- [ ] Raydium pool creation can be detected.
- [ ] One generic EVM adapter powers BSC, Base, and Robinhood.
- [ ] Relevant EVM pool factory events are detected.
- [ ] Candidate events are normalized into one model.
- [ ] Duplicate detections are merged.
- [ ] `firstSeenAt` is preserved.
- [ ] `tradeableAt` is stored separately.
- [ ] FOMO appearance can be recorded through an isolated provider.
- [ ] Lead time is calculated.
- [ ] Risk validation is performed.
- [ ] Telegram notifications support inline actions.
- [ ] Manual buy revalidates before transaction signing.
- [ ] Trades are persisted.
- [ ] Positions are persisted.
- [ ] Sell actions work for supported venues.
- [ ] Wallet limits are enforced.
- [ ] Auto-buy is disabled by default.
- [ ] `/pause` prevents future automatic execution.
- [ ] RPC reconnects do not create duplicate trades.
- [ ] All important trading decisions are auditable.
- [ ] Tests cover event decoding and strategy rules.
- [ ] Secrets are not committed to source control.
- [ ] Protocol addresses are configuration-driven.

---

# 71. Initial Coding-Agent Prompt

Use the following instruction when starting the implementation in Codex or Claude Code:

```text
Implement the project described in this specification incrementally.

Use Node.js 22+, TypeScript, grammY, PostgreSQL + Prisma, Redis + BullMQ,
@solana/web3.js for Solana compatibility, and viem for EVM chains.

Important architectural constraints:

1. Pump.fun is a Solana protocol, not a separate chain.
2. Solana, BSC, Base, and Robinhood must normalize detections into the same TokenCandidate model.
3. BSC, Base, and Robinhood must share a generic EVM adapter.
4. Keep discovery, validation, strategy, trading, wallet signing, FOMO matching, and Telegram UI as separate modules.
5. The first implementation must run in DISCOVERY_ONLY mode.
6. Do not implement auto-buy before discovery, persistence, validation, lead-time measurement, and manual execution are complete.
7. Never auto-buy on raw token contract/mint creation alone.
8. A tradeability signal must come from an active bonding curve, usable pool, or equivalent verified trading venue.
9. Never hardcode protocol addresses from memory. Verify current official addresses, chain IDs, ABIs, and program IDs before committing them.
10. All addresses and network parameters must be configuration-driven.
11. Preserve millisecond-precision first-seen and tradeable timestamps.
12. Design all WebSocket listeners to reconnect and deduplicate events.
13. Do not expose or log wallet private keys.
14. Add tests for every event decoder and strategy rule.
15. Build one milestone at a time and keep the application runnable after each milestone.

Start with Milestone A:
- initialize the TypeScript project
- add configuration validation
- create the directory structure
- configure PostgreSQL/Prisma
- configure Redis/BullMQ
- configure structured logging
- implement Telegram /start, /help, /status, and /health
- create TokenCandidate and event-bus types
- add Docker Compose for local PostgreSQL and Redis
- add Vitest and basic smoke tests

After completing Milestone A, continue with Pump.fun discovery while keeping trading disabled.
```

---

# 72. Final Architecture Summary

```text
                           TELEGRAM
                              │
                              ▼
                       Strategy / UI
                              │
        ┌─────────────────────┴──────────────────────┐
        │                                            │
        ▼                                            ▼
   DISCOVERY                                    EXECUTION
        │                                            │
 ┌──────┴───────┐                             ┌──────┴──────┐
 │              │                             │             │
Solana          EVM                          Solana         EVM
 │              │                             │             │
 ├ Pump.fun     ├ BSC                         ├ Pump         ├ DEX
 ├ Raydium      ├ Base                        └ Raydium      └ Router
 └ SPL          └ Robinhood
        │
        ▼
 TokenCandidate
        │
        ├── first-seen timestamp
        ├── tradeable timestamp
        ├── liquidity
        ├── source
        ├── risk
        └── FOMO timestamp
                 │
                 ▼
            LEAD METRICS
```

The core concept is:

> **Find new tokens directly from blockchain events, determine when they actually become tradeable, measure whether this happens before FOMO lists them, and only then add controlled execution.**

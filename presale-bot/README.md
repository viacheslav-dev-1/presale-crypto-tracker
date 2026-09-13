# Multi-Chain Pre-FOMO Bot

Telegram implementation of the controls and candidate notifications described in
[`multi_chain_pre_fomo_bot_spec.md`](./multi_chain_pre_fomo_bot_spec.md).

## Run locally

Requires Node.js 22 or newer.

```bash
cp .env.example .env
# Set TELEGRAM_BOT_TOKEN and the Solana RPC endpoints in .env
npm install
npm run dev
```

The bot operates exclusively in `DISCOVERY_ONLY` mode. Anyone can open it and send
`/start` to subscribe to alerts. `TELEGRAM_ADMIN_IDS` is optional; when provided,
those chats are pre-subscribed on startup.

Pump.fun discovery starts when `SOLANA_RPC_HTTP` is configured. Set
`SOLANA_RPC_WS` as well when your provider exposes a dedicated WebSocket URL. The
detector subscribes to the configured Pump program, decodes both `create` and
`create_v2` launches, deduplicates them, and sends normalized Telegram alerts.
Use a paid/production RPC for sustained mainnet log volume; public endpoints are
commonly rate-limited. Optional holder lookups are serialized and pause for 60
seconds after an HTTP 429 so enrichment cannot block token alerts. The public
Solana endpoint is suitable for testing, but a dedicated RPC is recommended for
production holder data.

BSC discovery starts when `BSC_RPC_HTTP` is configured. Use an RPC
provider that supports `eth_getLogs`, or provide its WebSocket endpoint through
`BSC_RPC_WS`; BNB Chain's free public mainnet endpoints disable `eth_getLogs` and
are therefore unsuitable for this detector. The adapter validates chain ID `56`
and watches PancakeSwap V2 `PairCreated` and V3 `PoolCreated` events. Defaults:

```dotenv
BSC_RPC_HTTP=https://your-bsc-rpc.example
BSC_RPC_WS=wss://your-bsc-websocket.example
BSC_CHAIN_ID=56
# Optional comma-separated overrides:
# BSC_QUOTE_TOKENS=0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c,0x55d398326f99059fF775485246999027B3197955,0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d
# BSC_USD_STABLE_TOKENS=0x55d398326f99059fF775485246999027B3197955,0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d
# BSC_V2_FACTORIES=0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73
# BSC_V3_FACTORIES=0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865
```

BSC alerts use the same full/light formats, filters, risk calculation, freshness
checks, digest delivery, creator-history gate, holder refresh, Fomo link, and
explorer link as the other chains. Prices and market caps are derived from pool
state and total supply; WBNB quotes use a cached BNB/USD price, while USDT/USDC
quotes are treated as USD. V2 liquidity and impact estimates use PancakeSwap's
0.25% fee. V3 reports price but keeps usable in-range liquidity unavailable until
a quoter or swap simulation is added.

Base discovery starts when `BASE_RPC_HTTP` is configured. `BASE_RPC_WS` is
recommended for lower-latency event delivery. The adapter validates chain ID
`8453` and watches the official Uniswap V2 factory, V3 factory, and V4
PoolManager. Defaults:

```dotenv
BASE_RPC_HTTP=https://mainnet.base.org
# The public HTTP endpoint supports polling. Set your provider's WSS URL when available:
# BASE_RPC_WS=wss://your-base-websocket-provider.example
BASE_CHAIN_ID=8453
# Optional comma-separated overrides:
# BASE_QUOTE_TOKENS=0x4200000000000000000000000000000000000006,0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
# BASE_USD_STABLE_TOKENS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
# BASE_V2_FACTORIES=0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6
# BASE_V3_FACTORIES=0x33128a8fC17869897dcE68Ed026d694621f6FDfD
# BASE_V4_POOL_MANAGERS=0x498581fF718922c3f8e6A244956aF099B2652b2b
```

Base alerts use the same message formats, market-cap filters, risk evaluation,
holder refresh, creator-history gate, freshness checks, digest delivery, Fomo
link, and BaseScan link as the existing integrations. WETH pools use a cached
ETH/USD price and USDC pools are valued directly in USD. HTTP detection uses
stateless block-range `eth_getLogs` polling so load-balanced RPC endpoints cannot
invalidate server-side filter IDs between requests.

Set the optional `HELIUS_API_KEY` to use Helius's indexed token-account API for
Solana holder snapshots. The bot aggregates all non-zero token accounts by owner,
so the displayed count is the number of unique holder wallets rather than the
number of token accounts. Every candidate message includes a **Refresh holders**
button that requests a current snapshot and sends the updated top five. If the
key's plan permits Wallet Identity queries, known public labels are shown beside
addresses; otherwise addresses remain the fallback. These provider labels are
not Fomo-specific usernames such as `MomoOnChain` unless the provider independently
knows that identity.

Robinhood Chain discovery uses the shared EVM DEX adapter and listens to the
official Uniswap V2 `PairCreated`, V3 `PoolCreated`, and V4 `Initialize` events on mainnet
(chain ID `4663`). Configure `ROBINHOOD_RPC_HTTP` or, preferably, an Alchemy-style
`ROBINHOOD_RPC_WS` endpoint. Factory and quote-token addresses can be overridden
with `ROBINHOOD_V2_FACTORIES`, `ROBINHOOD_V3_FACTORIES`, `ROBINHOOD_V4_POOL_MANAGERS`, and
`ROBINHOOD_QUOTE_TOKENS`. The alert includes the factory name. Market cap and
token price are derived from V2 reserves or V3/V4 pool price state, total supply,
and the USD value of the quote token. Empty or uninitialized pools remain
`Unavailable` instead of displaying a fabricated valuation.

## Liquidity information

Candidate alerts show a compact liquidity value and a native expandable
**Liquidity details** section. It includes venue type, normalized token and quote
reserves, liquidity-to-market-cap percentage, estimated buy price impact for
`$25`, `$50`, and `$100`, liquidity-control status, and calculation limitations.

Pump.fun effective liquidity is calculated from both sides of its live virtual
bonding curve. It is clearly labeled **virtual** because curve parameters are not
proof of withdrawable or locked LP assets, and its impact estimates exclude
venue fees and execution-state changes. Robinhood Uniswap V2 liquidity is derived
from live reserves; impact estimates assume the standard 0.30% input fee. V2 LP
locking/burning remains `UNVERIFIED` until LP ownership is inspected. V3/V4 spot
prices are shown when available, but liquidity and price impact remain unavailable
until a live quoter or swap simulation can inspect in-range liquidity.

Implemented commands: `/start`, `/stop`, `/help`, `/status`, `/health`, `/chains`,
`/delivery`, `/marketcap`, and the four `/enable_<chain>` commands. Each chat
can choose immediate token alerts or a combined digest every 1, 2, 5, or 10 minutes. Large digests are split across
numbered Telegram messages so every detected token is included. Candidate notifications
never expose trading or buy controls.
Every chat can choose its own discovery chains. Disabling a chain removes that
chat's queued digest entries and blocks future alerts from that chain without
affecting other users. The selection is stored as `enabledChains` in each entry of
`.data/telegram-audience.json` and restored after restart. New chats default to
Robinhood only. Each user can then enable or disable chains from their own menu.

Each chat can switch the Telegram **Message format** control between `FULL` and
`LIGHT`; `LIGHT` is the default. Light alerts show the risk circle beside the token
name, followed by chain/source/factory and price/capitalization lines. Light risk is
shown as `🟢` for lower, `🟡` for moderate, and `🔴` for elevated/high/extreme;
pending risk is `⚪`. Light capitalization omits the detailed view's approximate
marker, and V4 factory labels omit `PoolManager`. Permanent `[FOMO] [EXPLORER]`
text links sit beside the token name and remain useful after forwarding. The bottom
contains the complete copyable token address. The only inline control is **DETAILS**, which opens
the complete existing alert without changing the saved format. Full/detailed
messages also include permanent `[FOMO] [EXPLORER]` text links for forwarding.
Light digests keep
the same compact entries and token-specific navigation controls, splitting at 20
tokens per page to stay within Telegram keyboard limits.
Each candidate also includes an **Open in Fomo** link to the exact chain/address
route and an **Explorer** fallback. The HTTPS Fomo link can open the mobile app
when its universal-link association is available; otherwise it opens Fomo's web
token page in the browser. Explorer fallbacks use raw account/contract routes so
new launches do not depend on the explorer's slower token-metadata index. Before
notification, Solana mints are checked for an existing account owned by the
expected token program, and EVM pool tokens must expose a non-empty ERC-20 symbol,
valid decimals, and a positive total supply. Indeterminate RPC failures do not
discard candidates; only definitive invalid results are filtered.
The main menu also has a per-chat **Holders** switch, which defaults to On.
Solana alerts enumerate non-zero token accounts, aggregate them by owner wallet,
show the exact holder count, and rank up to five largest wallets. BSC and Robinhood alerts show non-zero known holders available at discovery
(the pool/PoolManager and pool-creation transaction sender). Wallet addresses,
token balances, ownership percentages, and USD values are shown when available.

Each chat also has a persistent market-cap range filter, defaulting to Min `$0`
and Max `$10,000`. Use `/marketcap` or the **Cap** menu control to set Min and Max
independently with values such as `10000`, `$25,000`, `50K`, or `1M`. Pump.fun capitalization is derived from the live
bonding-curve reserves and a cached SOL/USD market price. When creation-event
reserves are absent, the detector reads the bonding-curve account as a fallback.
Alerts also show the token's current USD price derived from those reserves.
Tokens still lacking a calculable cap are excluded from range filtering, but the
bot sends a summarized notice instead of silently hiding them. The Market Cap
menu also offers **Track tokens without cap**, which is Off by default. Delivered
candidate IDs are persisted per chat in `.data/telegram-delivery-history.json`
(`TELEGRAM_DELIVERY_HISTORY_FILE`) rather than in the audience preferences file,
so later reserve updates and ordinary process restarts do not produce duplicate
alerts for the same token. Existing `deliveredCandidateIds` values are migrated
out of `telegram-audience.json` automatically. Sending `/stop`, using the menu's
unsubscribe action, or starting/subscribing again clears that chat's delivery
history and begins a fresh delivery session. A workspace process lock prevents
multiple local bot instances from running with the same data and sending duplicates.

## Risk assessment

Every detected candidate receives a deterministic `0–100` observed-risk score,
level, confidence, evidence list, and list of checks that remain unverified. The
current model considers confirmed tradeability, market cap, liquidity, unique
holder count, external-wallet concentration (excluding the known pool/bonding
curve), creator concentration, and Solana mint/freeze authority. Token-2022 mints
receive an additional warning until their extensions are fully inspected. Holder
refreshes recalculate the score using the latest positions.

Telegram keeps the score, level, assessment status, and confidence visible. The
long evidence, unverified-check list, and disclaimer are placed inside Telegram's
native expandable blockquote so users can reveal or collapse them in-place.

The assessment remains `INSUFFICIENT DATA` while buy/sell simulation is absent.
It is an explainable heuristic, not a guarantee or a buy recommendation, and it
does not authorize automatic trading.
Candidates use their on-chain creation/block timestamp and are discarded when
older than 10 minutes by default. Override the freshness window with
`MAX_CANDIDATE_AGE_MS` if needed.

## Creator history

The main menu includes a per-chat **Enable Creator History** switch, which defaults
to Off and is persisted across restarts. Creator-history collection is skipped
entirely while no subscribed chat has enabled it. Enabled chats receive the
creator wallet and a native expandable **Creator history** block; disabled chats
do not receive creator-history data or history-based risk adjustments.
The bot persistently groups launches by chain and creator, then reports previous
launches observed, launches that reached meaningful liquidity, 90% market-cap
drawdowns, 90% liquidity drops, average observed tracking duration, current
creator ownership, and the first creator balance decrease observed after launch.
The default meaningful-liquidity threshold is `$25,000`; override it with
`CREATOR_MEANINGFUL_LIQUIDITY_USD`. History is stored in
`.data/creator-history.json` by default and can be moved with
`CREATOR_HISTORY_FILE`.

Pump.fun supplies its creator directly. BSC and Robinhood candidates use the pool-creation
transaction sender. With `HELIUS_API_KEY`, Solana creator records also attempt to
show the wallet's original funding address, public provider label, initial SOL
amount, and funding age. This enrichment is cached to minimize provider usage and
fails open when the endpoint or plan is unavailable.

All history is labeled **observed by this bot**. It begins when this installation
sees a creator and is not presented as a complete historical chain scan. A severe
price or liquidity decline raises the heuristic risk score, but is not labeled a
rug without proof of control and withdrawal.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

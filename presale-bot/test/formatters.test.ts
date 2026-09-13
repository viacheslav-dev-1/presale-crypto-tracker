import { describe, expect, it, vi } from "vitest";
import { escapeHtml, formatCandidate, formatCandidateDigest, formatCandidateDigestMessages, formatCandidateDigestPages, formatCompactUsdTokenPrice, formatLightCandidate, formatStatus } from "../src/bot/formatters.js";
import { candidateCallbackId, candidateKeyboard, fomoTokenUrl, lightDigestKeyboard, mainMenuKeyboard, tokenExplorerUrl } from "../src/bot/keyboards.js";

describe("Telegram formatters", () => {
  it("escapes untrusted token metadata before using Telegram HTML", () => {
    expect(escapeHtml("A&B<script>")).toBe("A&amp;B&lt;script&gt;");
  });

  it("formats a candidate notification from the normalized domain model", () => {
    const text = formatCandidate(
      {
        id: "candidate-1",
        chain: "base",
        source: "dex-pool",
        address: "0x123",
        symbol: "TEST<ONE>",
        discoveredAt: new Date("2026-09-10T10:00:00.000Z"),
        tradeableAt: new Date("2026-09-10T10:00:00.100Z"),
        liquidityUsd: 18_420,
        marketCapUsd: 42_500,
        priceUsd: 0.0000425,
        fomoListed: false,
        riskScore: 28,
        tradable: true,
      },
      new Date("2026-09-10T10:00:01.400Z"),
    );
    expect(text).toContain("🚨 <b>TEST&lt;ONE&gt;</b>");
    expect(text).not.toContain("NEW POOL");
    expect(text).not.toContain("PRE-FOMO TOKEN");
    expect(text).toContain("Detected: 1.4 sec ago");
    expect(text).toContain("Risk: ⚪ 28/100");
    expect(text).toContain("Market cap: ~$42,500");
    expect(text).toContain("Token price: $0.0000425");
    expect(text).toContain("[<a href=\"https://fomo.family/tokens/base/0x123\">FOMO</a>]");
    expect(text).toContain("[<a href=\"https://basescan.org/address/0x123\">EXPLORER</a>]");
    expect(text).not.toContain("Tradeable:");
    expect(text).not.toContain("FOMO:");
  });

  it("formats the three-line light candidate summary", () => {
    const text = formatLightCandidate({
      id: "robinhood:light",
      chain: "robinhood",
      source: "dex-pool",
      address: "0xTokenContract",
      symbol: "LIGHT",
      priceUsd: 0.0000123,
      marketCapUsd: 42_500,
      discoveredAt: new Date(),
      fomoListed: false,
      riskScore: 32,
      riskAssessment: {
        status: "ASSESSED",
        level: "MODERATE",
        confidence: "MEDIUM",
        factors: [],
        missingChecks: [],
      },
      metadata: { factoryName: "Uniswap V3" },
    });
    expect(text.split("\n")).toEqual([
      "🟡 <b>LIGHT</b> [<a href=\"https://fomo.family/tokens/robinhood/0xTokenContract\">FOMO</a>] [<a href=\"https://robinhoodchain.blockscout.com/address/0xTokenContract\">EXPLORER</a>]",
      "",
      "🔗 Robinhood | dex-pool | Uniswap V3",
      "",
      "🤑 P: $0.0(3)123 | C: $42,500",
      "",
      "<code>0xTokenContract</code>",
    ]);
  });

  it("compresses additional leading fractional zeros in light prices", () => {
    expect(formatCompactUsdTokenPrice(0.01)).toBe("0.01");
    expect(formatCompactUsdTokenPrice(0.00123)).toBe("0.00123");
    expect(formatCompactUsdTokenPrice(0.000123)).toBe("0.0(2)123");
    expect(formatCompactUsdTokenPrice(0.00000042)).toBe("0.0(5)42");
  });

  it("removes PoolManager and maps high light-mode risk to a red circle", () => {
    const text = formatLightCandidate({
      id: "robinhood:v4",
      chain: "robinhood",
      source: "dex-pool",
      address: "0x123",
      symbol: "V4",
      marketCapUsd: 1_000,
      discoveredAt: new Date(),
      fomoListed: false,
      riskAssessment: {
        status: "ASSESSED",
        level: "HIGH",
        confidence: "HIGH",
        factors: [],
        missingChecks: [],
      },
      metadata: { factoryName: "Uniswap V4 PoolManager" },
    });
    expect(text).toContain("🔗 Robinhood | dex-pool | Uniswap V4");
    expect(text).not.toContain("PoolManager");
    expect(text).toContain("🔴 <b>V4</b> [<a href=");
    expect(text).toContain("🤑 P: Unavailable | C: $1,000");
  });

  it("formats status without exposing secrets", () => {
    vi.setSystemTime(new Date("2026-09-10T10:01:00.000Z"));
    const text = formatStatus({
      mode: "DISCOVERY_ONLY",
      startedAt: new Date("2026-09-10T10:00:00.000Z"),
      detections: 4,
    }, ["solana", "base"]);
    expect(text).toContain("Solana, Base");
    expect(text).toContain("Detections: 4");
    expect(text).toContain("Uptime: 1m 0s");
    vi.useRealTimers();
  });

  it("keeps candidate callback data within Telegram's 64-byte limit", () => {
    const id = "candidate/".repeat(30);
    const callbackId = candidateCallbackId(id);
    const keyboard = candidateKeyboard(
      {
        id,
        chain: "solana",
        source: "pumpfun",
        address: "mint",
        discoveredAt: new Date(),
        fomoListed: false,
        tradable: true,
      },
    );
    const callbacks = keyboard.inline_keyboard.flatMap((row) => row.map((button) => "callback_data" in button ? button.callback_data : ""));
    expect(callbackId).toHaveLength(22);
    expect(callbacks.every((data) => Buffer.byteLength(data, "utf8") <= 64)).toBe(true);
    expect(callbacks).toContain(`holders:${callbackId}`);
  });

  it("uses only the DETAILS inline control for a light candidate", () => {
    const keyboard = candidateKeyboard({
      id: "solana:light",
      chain: "solana",
      source: "pumpfun",
      address: "Mint",
      discoveredAt: new Date(),
      fomoListed: false,
    }, true);
    expect(keyboard.inline_keyboard.map((row) => row.map((button) => button.text))).toEqual([
      ["DETAILS"],
    ]);
  });

  it("does not expose trading-mode or pause controls in the main menu", () => {
    const keyboard = mainMenuKeyboard({
      subscribed: true,
      deliveryMode: "ONE_MINUTE_DIGEST",
      digestIntervalMinutes: 1,
      minimumMarketCapUsd: 0,
      maximumMarketCapUsd: 10_000,
      showHolders: true,
      showCreatorHistory: false,
      messageFormat: "LIGHT",
    });
    const labels = keyboard.inline_keyboard.flatMap((row) => row.map((button) => button.text));
    expect(labels).toContain("⛓ Chains");
    expect(labels.some((label) => /mode|pause|resume|buy/i.test(label))).toBe(false);
  });

  it("links candidate buttons to the exact Fomo and explorer token pages", () => {
    const bnbCandidate = {
      id: "bsc:token",
      chain: "bsc" as const,
      source: "dex-pool" as const,
      address: "0x1234567890abcdef",
      discoveredAt: new Date(),
      fomoListed: false,
    };
    const keyboard = candidateKeyboard(bnbCandidate);
    const urls = keyboard.inline_keyboard.flatMap((row) => row.flatMap((button) => "url" in button ? [button.url] : []));

    expect(fomoTokenUrl(bnbCandidate)).toBe("https://fomo.family/tokens/bnb/0x1234567890abcdef");
    expect(tokenExplorerUrl(bnbCandidate)).toBe("https://bscscan.com/address/0x1234567890abcdef");
    expect(urls).toEqual([
      "https://fomo.family/tokens/bnb/0x1234567890abcdef",
      "https://bscscan.com/address/0x1234567890abcdef",
    ]);
    expect(fomoTokenUrl({ chain: "solana", address: "MintAddress" })).toBe(
      "https://fomo.family/tokens/solana/MintAddress",
    );
    expect(fomoTokenUrl({ chain: "robinhood", address: "0xRobinhood" })).toBe(
      "https://fomo.family/tokens/robinhood/0xRobinhood",
    );
  });

  it("distinguishes a Solana mint from its shared token smart contract", () => {
    const text = formatCandidate({
      id: "solana:mint",
      chain: "solana",
      source: "pumpfun",
      address: "MintAddress",
      tokenProgram: "TokenProgramAddress",
      poolAddress: "BondingCurveAddress",
      discoveredAt: new Date(),
      fomoListed: false,
    });
    expect(text).toContain("Mint / Token Address: <code>MintAddress</code>");
    expect(text).toContain("Token Program (shared smart contract): <code>TokenProgramAddress</code>");
    expect(text).toContain("Pool: <code>BondingCurveAddress</code>");
    expect(text).toContain("Market cap: Unavailable");
    expect(text).toContain("Token price: Unavailable");
  });

  it("shows Robinhood token and DEX smart-contract addresses explicitly", () => {
    const text = formatCandidate({
      id: "robinhood:token",
      chain: "robinhood",
      source: "dex-pool",
      address: "0xTokenContract",
      poolAddress: "0xPoolContract",
      symbol: "RBN",
      discoveredAt: new Date(),
      fomoListed: false,
      metadata: {
        factory: "0xFactoryContract",
        factoryName: "Uniswap V3",
        factoryType: "v3",
      },
    });
    expect(text).toContain("Token / Smart Contract Address: <code>0xTokenContract</code>");
    expect(text).toContain("DEX Factory (smart contract): <code>0xFactoryContract</code>");
    expect(text).toContain("Factory: Uniswap V3");
    expect(text).toContain("Pool: <code>0xPoolContract</code>");
  });

  it("splits a high-volume digest without omitting token details", () => {
    const candidates = Array.from({ length: 100 }, (_, index) => ({
      id: `solana:${index}`,
      chain: "solana" as const,
      source: "pumpfun" as const,
      address: `Mint${index}${"x".repeat(40)}`,
      poolAddress: `Pool${index}${"y".repeat(40)}`,
      symbol: `TOKEN${index}`,
      discoveredAt: new Date(),
      fomoListed: false,
    }));
    const messages = formatCandidateDigestMessages(candidates);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= 4_096)).toBe(true);
    expect(messages[0]).toContain(`(1/${messages.length})`);
    expect(messages.at(-1)).toContain(`(${messages.length}/${messages.length})`);
    const completeDigest = messages.join("\n");
    candidates.forEach((candidate) => {
      expect(completeDigest).toContain(`<code>${candidate.address}</code>`);
      expect(completeDigest).toContain(`<code>${candidate.poolAddress}</code>`);
    });
  });

  it("splits light digests at the inline-keyboard limit and retains per-token controls", () => {
    const candidates = Array.from({ length: 30 }, (_, index) => ({
      id: `solana:light-${index}`,
      chain: "solana" as const,
      source: "pumpfun" as const,
      address: `Mint${index}`,
      symbol: `L${index}`,
      marketCapUsd: 5_000,
      discoveredAt: new Date(),
      fomoListed: false,
    }));
    const pages = formatCandidateDigestPages(candidates, new Date(), 5, { messageFormat: "LIGHT" });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.reduce((count, page) => count + page.candidates.length, 0)).toBe(30);
    expect(pages.every((page) => page.candidates.length <= 20)).toBe(true);
    expect(pages[0]?.text).toContain("⚪ <b>L0</b>");
    expect(pages[0]?.text).toContain("<code>Mint0</code>");
    expect(pages[0]?.text).toContain(
      '[<a href="https://fomo.family/tokens/solana/Mint0">FOMO</a>] [<a href="https://solscan.io/account/Mint0">EXPLORER</a>]',
    );
    expect(lightDigestKeyboard(pages[0]?.candidates ?? []).inline_keyboard)
      .toHaveLength(pages[0]?.candidates.length ?? 0);
  });

  it("uses the same complete token details in instant and digest formats", () => {
    const candidate = {
      id: "solana:full",
      chain: "solana" as const,
      source: "pumpfun" as const,
      address: "FullMint",
      tokenProgram: "SharedTokenProgram",
      poolAddress: "FullPool",
      symbol: "FULL",
      liquidityUsd: 12_345,
      marketCapUsd: 45_678,
      priceUsd: 0.000045678,
      discoveredAt: new Date(),
      fomoListed: false,
      tradable: true,
      riskScore: 20,
    };
    const instant = formatCandidate(candidate);
    const digest = formatCandidateDigest([candidate]);
    for (const detail of [
      "Chain: Solana",
      "Source: pumpfun",
      "Mint / Token Address: <code>FullMint</code>",
      "Token Program (shared smart contract): <code>SharedTokenProgram</code>",
      "Pool: <code>FullPool</code>",
      "Liquidity: ~$12,345",
      "Market cap: ~$45,678",
      "Token price: $0.000045678",
      "Risk: ⚪ 20/100",
    ]) {
      expect(instant).toContain(detail);
      expect(digest).toContain(detail);
    }
    expect(digest).not.toMatch(/<b>Token \d+<\/b>/);
    expect(digest).toContain(
      '[<a href="https://fomo.family/tokens/solana/FullMint">FOMO</a>] [<a href="https://solscan.io/account/FullMint">EXPLORER</a>]',
    );
    expect(instant).not.toContain("Tradeable:");
    expect(instant).not.toContain("FOMO:");
  });

  it("shows holder wallet, balance, ownership share, and USD value when enabled", () => {
    const candidate = {
      id: "solana:holders",
      chain: "solana" as const,
      source: "pumpfun" as const,
      address: "Mint",
      discoveredAt: new Date(),
      fomoListed: false,
      holderCount: 1,
      holders: [{ address: "Wallet123", label: "Known Trader", balance: 12_500, percentage: 12.5, valueUsd: 625 }],
    };
    expect(formatCandidate(candidate)).toContain("Total holders: 1");
    expect(formatCandidate(candidate)).toContain("#1 Known Trader — <code>Wallet123</code>: 12,500 (12.50%) · ~$625");
    expect(formatCandidate(candidate, new Date(), { showHolders: false })).not.toContain("Top 5 holders");
  });

  it("shows an explained risk assessment and its unverified checks", () => {
    const text = formatCandidate({
      id: "solana:risk",
      chain: "solana",
      source: "pumpfun",
      address: "Mint",
      discoveredAt: new Date(),
      fomoListed: false,
      riskScore: 55,
      riskAssessment: {
        status: "INSUFFICIENT_DATA",
        level: "ELEVATED",
        confidence: "LOW",
        factors: ["+25: mint authority can create more supply", "✓ pool inventory excluded"],
        missingChecks: ["buy and sell simulation"],
      },
    });
    expect(text).toContain("Risk: 🔴 <b>55/100 · ELEVATED</b>");
    expect(text).toContain("Risk assessment: <b>INSUFFICIENT DATA</b>");
    expect(text).toContain("<blockquote expandable><b>Risk evidence</b>");
    expect(text).toContain("• +25: mint authority can create more supply");
    expect(text).toContain("• buy and sell simulation");
    expect(text).toContain("not a guarantee or buy recommendation.</i></blockquote>");
  });

  it("shows compact liquidity and expandable reserve and impact details", () => {
    const text = formatCandidate({
      id: "solana:liquidity",
      chain: "solana",
      source: "pumpfun",
      address: "Mint",
      discoveredAt: new Date(),
      fomoListed: false,
      marketCapUsd: 10_000,
      liquidityUsd: 12_000,
      liquidityAnalysis: {
        venueType: "BONDING_CURVE",
        effectiveLiquidityUsd: 12_000,
        tokenReserve: 1_073_000_000,
        quoteReserve: 30,
        quoteSymbol: "SOL",
        liquidityToMarketCapPercent: 120,
        priceImpactEstimates: [
          { tradeUsd: 25, impactPercent: 0.42 },
          { tradeUsd: 50, impactPercent: 0.83 },
          { tradeUsd: 100, impactPercent: 1.67 },
        ],
        controlStatus: "PROGRAM_CONTROLLED",
        controlDescription: "Pump.fun controls reserves",
        warnings: ["Virtual reserves are not locked LP value"],
      },
    });
    expect(text).toContain("Effective virtual liquidity: ~$12,000");
    expect(text).toContain("<blockquote expandable><b>Liquidity details</b>");
    expect(text).toContain("Quote reserve: 30 SOL");
    expect(text).toContain("Liquidity / market cap: 120.00%");
    expect(text).toContain("• $50: 0.83%");
    expect(text).toContain("Liquidity control: <b>PROGRAM CONTROLLED</b>");
  });

  it("shows creator history in an expandable evidence section", () => {
    const text = formatCandidate({
      id: "solana:creator-history",
      chain: "solana",
      source: "pumpfun",
      address: "Mint",
      creator: "CreatorWallet",
      discoveredAt: new Date("2026-09-13T10:00:00.000Z"),
      fomoListed: false,
      creatorHistory: {
        creator: "CreatorWallet",
        coverageStartedAt: "2026-09-01T00:00:00.000Z",
        observedLaunches: 4,
        previousObservedLaunches: 3,
        previousTokens: [{
          address: "OldMint",
          symbol: "OLD",
          discoveredAt: "2026-09-10T00:00:00.000Z",
          reachedMeaningfulLiquidity: true,
          lostNinetyPercent: true,
          severeLiquidityDrop: false,
        }],
        meaningfulLiquidityUsd: 25_000,
        reachedMeaningfulLiquidity: 2,
        lostNinetyPercent: 1,
        severeLiquidityDrops: 1,
        averageObservedDurationMs: 86_400_000,
        currentHoldingPercent: 8.25,
        firstObservedSaleAt: "2026-09-13T10:03:00.000Z",
        funding: {
          address: "FundingWallet",
          label: "Known Exchange",
          amount: 1.5,
          symbol: "SOL",
          fundedAt: "2026-09-03T10:00:00.000Z",
        },
        warnings: ["Local observations only"],
      },
    }, new Date("2026-09-13T10:00:00.000Z"));

    expect(text).toContain("Creator: <code>CreatorWallet</code>");
    expect(text).toContain("Creator launches observed: 4");
    expect(text).toContain("<blockquote expandable><b>Creator history · observed by this bot</b>");
    expect(text).toContain("Previous launches observed: 3");
    expect(text).toContain("• OLD · <code>OldMint</code> — reached liquidity, down ≥90%");
    expect(text).toContain("Reached ≥$25,000 liquidity: 2 / 4");
    expect(text).toContain("Current creator holding: 8.25%");
    expect(text).toContain("Funded by: Known Exchange — <code>FundingWallet</code>");
    expect(text).toContain("Wallet funding age: 10d 0h");
  });
});

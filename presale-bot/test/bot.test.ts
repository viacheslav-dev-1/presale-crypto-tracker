import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { Update } from "grammy/types";
import { createTelegramBot, parseMarketCapInput } from "../src/bot/bot.js";
import { createBotState } from "../src/bot/state.js";
import { createTelegramAudience } from "../src/bot/services.js";
import type { AppConfig } from "../src/config.js";
import type { TokenCandidate } from "../src/domain/token-candidate.js";

const config: AppConfig = {
  nodeEnv: "test",
  telegramToken: "123456:test-token",
  telegramAdminIds: new Set([123]),
  telegramAudienceFile: ".data/test-audience.json",
  telegramDeliveryHistoryFile: ".data/test-delivery-history.json",
  creatorHistoryFile: ".data/test-creator-history.json",
  creatorMeaningfulLiquidityUsd: 25_000,
  defaultDeliveryMode: "IMMEDIATE",
  immediateMessageIntervalMs: 2_000,
  maxCandidateAgeMs: 600_000,
  defaultMinimumMarketCapUsd: 0,
  defaultMaximumMarketCapUsd: 10_000,
  enabledChains: ["solana", "base"],
  logLevel: "silent",
  solana: {
    commitment: "processed",
    pumpProgramId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  },
  robinhood: {
    id: 4663,
    key: "robinhood",
    name: "Robinhood Chain",
    httpRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    nativeSymbol: "ETH",
    quoteTokens: ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"],
    usdStableTokens: [],
    wrappedNativeToken: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    dexFactories: [],
    pollingIntervalMs: 1_000,
  },
};

function setup(
  testConfig: AppConfig = config,
  holderRefresher?: { refresh(candidate: TokenCandidate): Promise<TokenCandidate> },
  audienceOverride?: ReturnType<typeof createTelegramAudience>,
) {
  const state = createBotState();
  const { bot, notifier, configureUi, flushDigests } = createTelegramBot({
    config: testConfig,
    state,
    logger: pino({ level: "silent" }),
    ...(holderRefresher ? { holderRefresher } : {}),
    ...(audienceOverride ? { audience: audienceOverride } : {}),
  });
  bot.botInfo = {
    id: 123456,
    is_bot: true,
    first_name: "Pre-FOMO",
    username: "pre_fomo_test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };

  const sent: string[] = [];
  const apiCalls: Array<{ method: string; payload: { text?: unknown; chat_id?: unknown; commands?: unknown } }> = [];
  bot.api.config.use(async (_previous, method, payload) => {
    const request = payload as { text?: unknown; chat_id?: unknown };
    apiCalls.push({ method, payload: payload as { text?: unknown; chat_id?: unknown; commands?: unknown } });
    if (method === "sendMessage") sent.push(String(request.text));
    return {
      ok: true,
      result:
        method === "sendMessage"
          ? {
              message_id: 99,
              date: 1_789_033_600,
              chat: { id: Number(request.chat_id), type: "private", first_name: "User" },
              text: String(request.text),
            }
          : true,
    } as never;
  });
  return { bot, notifier, configureUi, flushDigests, sent, apiCalls };
}

function callbackUpdate(userId: number, data: string, updateId: number): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: userId, is_bot: false, first_name: "User" },
      chat_instance: "test-chat",
      data,
      message: {
        message_id: updateId,
        date: 1_789_033_600,
        chat: { id: userId, type: "private", first_name: "User" },
        text: "Candidate",
      },
    },
  };
}

function commandUpdate(userId: number, command: string, updateId: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_789_033_600,
      chat: { id: userId, type: "private", first_name: "User" },
      from: { id: userId, is_bot: false, first_name: "User" },
      text: command,
      entities: [{ offset: 0, length: command.length, type: "bot_command" as const }],
    },
  };
}

describe("Telegram commands", () => {
  it("parses manual market-cap amounts", () => {
    expect(parseMarketCapInput("10000")).toBe(10_000);
    expect(parseMarketCapInput("$25,000")).toBe(25_000);
    expect(parseMarketCapInput("50K")).toBe(50_000);
    expect(parseMarketCapInput("1.5M")).toBe(1_500_000);
    expect(parseMarketCapInput("not money")).toBeUndefined();
  });

  it("returns runtime status to a whitelisted administrator", async () => {
    const { bot, sent } = setup();
    await bot.handleUpdate(commandUpdate(123, "/status", 1));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Bot status");
    expect(sent[0]).toContain("DISCOVERY_ONLY");
    expect(sent[0]).toContain("Solana, Base");
  });

  it("allows non-operators to use public read-only commands", async () => {
    const { bot, sent } = setup();
    await bot.handleUpdate(commandUpdate(999, "/status", 2));
    expect(sent[0]).toContain("Bot status");
  });

  it("allows every chat to manage its own discovery chains", async () => {
    const { bot, sent } = setup();
    await bot.handleUpdate(commandUpdate(999, "/chains", 3));
    expect(sent).toEqual(["<b>Discovery chains for this chat</b>"]);
  });

  it("subscribes a public user to candidate alerts through /start", async () => {
    const publicConfig = { ...config, telegramAdminIds: new Set<number>() };
    const { bot, notifier, sent } = setup(publicConfig);
    await bot.handleUpdate(commandUpdate(999, "/start", 4));
    await notifier.candidateDetected({
      id: "solana:mint",
      chain: "solana",
      source: "pumpfun",
      address: "mint",
      symbol: "PUBLIC",
      marketCapUsd: 5_000,
      discoveredAt: new Date(),
      fomoListed: false,
      tradable: true,
    });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("subscribed to token alerts");
    expect(sent[1]).toContain("PUBLIC");
  });

  it("clears per-chat delivery history on stop and start", async () => {
    const audience = createTelegramAudience([999], "IMMEDIATE", 0, 10_000, ["solana"]);
    audience.markCandidateDelivered(999, "solana:old");
    const { bot } = setup({ ...config, telegramAdminIds: new Set<number>() }, undefined, audience);

    await bot.handleUpdate(commandUpdate(999, "/stop", 5));
    expect(audience.wasCandidateDelivered(999, "solana:old")).toBe(false);

    audience.markCandidateDelivered(999, "solana:another");
    await bot.handleUpdate(commandUpdate(999, "/start", 6));
    expect(audience.wasCandidateDelivered(999, "solana:another")).toBe(false);
  });

  it("registers the native Telegram slash-command menu", async () => {
    const { configureUi, apiCalls } = setup();
    await configureUi();
    const commandCall = apiCalls.find((call) => call.method === "setMyCommands");
    expect(commandCall?.payload.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "menu" }),
      expect.objectContaining({ command: "status" }),
      expect.objectContaining({ command: "chains" }),
    ]));
    const commandNames = (commandCall?.payload.commands as Array<{ command: string }> | undefined)
      ?.map(({ command }) => command) ?? [];
    expect(commandNames).not.toContain("mode");
    expect(commandNames).not.toContain("pause");
    expect(apiCalls.some((call) => call.method === "setChatMenuButton")).toBe(true);
  });

  it("refreshes holder positions from a candidate message button", async () => {
    const refresh = vi.fn(async (candidate: TokenCandidate): Promise<TokenCandidate> => ({
      ...candidate,
      holderCount: 1,
      holders: [{ address: "WalletLive", label: "Live Label", balance: 42 }],
    }));
    const { bot, notifier, sent } = setup(config, { refresh });
    await notifier.candidateDetected({
      id: "solana:refreshable",
      chain: "solana",
      source: "pumpfun",
      address: "RefreshableMint",
      symbol: "LIVE",
      marketCapUsd: 5_000,
      discoveredAt: new Date(),
      fomoListed: false,
    });

    await bot.handleUpdate(callbackUpdate(123, "holders:solana:refreshable", 50));

    expect(refresh).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("Total holders: 1");
    expect(sent[1]).toContain("Live Label — <code>WalletLive</code>: 42");
  });

  it("shows inline UI controls through /menu", async () => {
    const { bot, apiCalls } = setup();
    await bot.handleUpdate(commandUpdate(999, "/menu", 5));
    const send = apiCalls.find((call) => call.method === "sendMessage");
    const payload = send?.payload as { reply_markup?: { inline_keyboard?: unknown[][] } } | undefined;
    const buttons = payload?.reply_markup?.inline_keyboard?.flat() as Array<{ text?: string }> | undefined;
    expect(buttons).toHaveLength(10);
    expect(buttons?.some((button) => button.text === "🧑 Enable Creator History ❌")).toBe(true);
    expect(buttons?.some((button) => button.text === "📝 Message format: LIGHT")).toBe(true);
    expect(buttons?.some((button) => button.text === "⛓ Chains")).toBe(true);
  });

  it("keeps creator history off by default and enables it from the menu", async () => {
    const audience = createTelegramAudience([999], "IMMEDIATE", 0, 10_000, ["solana"]);
    audience.setMessageFormat(999, "FULL");
    const { bot, notifier, sent } = setup(config, undefined, audience);
    const candidate = {
      id: "solana:history-off",
      chain: "solana" as const,
      source: "pumpfun" as const,
      address: "Mint",
      creator: "Creator",
      marketCapUsd: 5_000,
      discoveredAt: new Date(),
      fomoListed: false,
      creatorHistory: {
        creator: "Creator",
        coverageStartedAt: new Date().toISOString(),
        observedLaunches: 2,
        previousObservedLaunches: 1,
        previousTokens: [],
        meaningfulLiquidityUsd: 25_000,
        reachedMeaningfulLiquidity: 1,
        lostNinetyPercent: 0,
        severeLiquidityDrops: 0,
        warnings: [],
      },
    };

    await notifier.candidateDetected(candidate);
    expect(sent.at(-1)).not.toContain("Creator launches observed");
    await bot.handleUpdate(callbackUpdate(999, "creator_history:toggle", 56));
    expect(audience.showCreatorHistory(999)).toBe(true);
    await notifier.candidateDetected({ ...candidate, id: "solana:history-on", address: "MintTwo" });
    expect(sent.at(-1)).toContain("Creator launches observed: 2");
  });

  it("switches to light alerts and opens the full message through DETAILS", async () => {
    const audience = createTelegramAudience([999], "IMMEDIATE", 0, 10_000, ["solana"]);
    const { bot, notifier, sent, apiCalls } = setup(config, undefined, audience);
    audience.setMessageFormat(999, "FULL");
    await bot.handleUpdate(callbackUpdate(999, "message_format:toggle", 57));
    expect(audience.messageFormat(999)).toBe("LIGHT");
    await notifier.candidateDetected({
      id: "solana:light",
      chain: "solana",
      source: "pumpfun",
      address: "LightMint",
      symbol: "LIGHT",
      priceUsd: 0.00001,
      marketCapUsd: 5_000,
      discoveredAt: new Date(),
      fomoListed: false,
      riskScore: 30,
      riskAssessment: {
        status: "ASSESSED",
        level: "MODERATE",
        confidence: "MEDIUM",
        factors: [],
        missingChecks: [],
      },
    });
    expect(sent.at(-1)?.split("\n")).toHaveLength(7);
    expect(sent.at(-1)).toContain("🟡 <b>LIGHT</b> [<a href=");
    expect(sent.at(-1)).toContain("🤑 P: $0.0(3)1 | C: $5,000");
    expect(sent.at(-1)).toContain("<code>LightMint</code>");
    expect(sent.at(-1)).toContain(">FOMO</a>] [<a href=");
    const notification = apiCalls.find((call) => call.method === "sendMessage" && call.payload.text === sent.at(-1));
    const buttons = (notification?.payload as { reply_markup?: { inline_keyboard?: Array<Array<{ text: string }>> } })
      .reply_markup?.inline_keyboard?.map((row) => row.map((button) => button.text));
    expect(buttons).toEqual([["DETAILS"]]);

    await bot.handleUpdate(callbackUpdate(999, "details:solana:light", 58));
    expect(sent.at(-1)).toContain("Chain: Solana");
    expect(sent.at(-1)).toContain("Mint / Token Address: <code>LightMint</code>");
  });

  it("changes enabled chains only for the requesting chat", async () => {
    const audience = createTelegramAudience([123, 999], "IMMEDIATE", 0, 10_000, ["solana"]);
    const { bot } = setup(config, undefined, audience);

    await bot.handleUpdate(callbackUpdate(123, "chain:solana", 51));

    expect(audience.enabledChains(123)).toEqual([]);
    expect(audience.enabledChains(999)).toEqual(["solana"]);
  });

  it("does not deliver candidates after their chain is disabled", async () => {
    const { bot, notifier, sent } = setup();
    await bot.handleUpdate(callbackUpdate(123, "chain:solana", 52));
    await notifier.candidateDetected({
      id: "solana:disabled",
      chain: "solana",
      source: "pumpfun",
      address: "DisabledMint",
      marketCapUsd: 5_000,
      discoveredAt: new Date(),
      fomoListed: false,
    });
    expect(sent).toHaveLength(0);
  });

  it("removes already queued Solana candidates when the chain is disabled", async () => {
    const digestConfig = { ...config, defaultDeliveryMode: "ONE_MINUTE_DIGEST" as const };
    const { bot, notifier, flushDigests, sent } = setup(digestConfig);
    await notifier.candidateDetected({
      id: "solana:queued-before-disable",
      chain: "solana",
      source: "pumpfun",
      address: "QueuedMint",
      marketCapUsd: 5_000,
      discoveredAt: new Date(),
      fomoListed: false,
    });
    await bot.handleUpdate(callbackUpdate(123, "chain:solana", 53));
    await flushDigests();

    expect(sent).toHaveLength(0);
  });

  it("combines queued candidates into one digest message", async () => {
    const publicConfig = { ...config, telegramAdminIds: new Set<number>() };
    const state = createBotState();
    const audience = createTelegramAudience([999], "ONE_MINUTE_DIGEST", 0, 10_000, ["solana"]);
    audience.setDeliveryMode(999, "ONE_MINUTE_DIGEST");
    const runtime = createTelegramBot({
      config: publicConfig,
      state,
      audience,
      digestIntervalMs: 3_600_000,
      logger: pino({ level: "silent" }),
    });
    const sent: string[] = [];
    runtime.bot.api.config.use(async (_previous, method, payload) => {
      const request = payload as { text?: unknown; chat_id?: unknown };
      if (method === "sendMessage") sent.push(String(request.text));
      return { ok: true, result: true } as never;
    });
    for (const symbol of ["ONE", "TWO"]) {
      await runtime.notifier.candidateDetected({
        id: `solana:${symbol}`,
        chain: "solana",
        source: "pumpfun",
        address: `${symbol}Mint`,
        symbol,
        marketCapUsd: 5_000,
        discoveredAt: new Date(),
        fomoListed: false,
        tradable: true,
      });
    }
    await runtime.notifier.candidateUpdated({
      id: "solana:ONE",
      chain: "solana",
      source: "pumpfun",
      address: "ONEMint",
      symbol: "ONE-UPDATED",
      marketCapUsd: 5_000,
      discoveredAt: new Date(),
      fomoListed: false,
      tradable: true,
    });
    expect(sent).toHaveLength(0);
    await runtime.flushDigests();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("1-MINUTE TOKEN DIGEST");
    expect(sent[0]).toContain("ONE-UPDATED");
    expect(sent[0]).toContain("TWO");
    expect(sent[0]).toContain("2 new tokens");
    expect(sent[0]).toContain('href="https://fomo.family/tokens/solana/ONEMint">FOMO</a>');
    expect(sent[0]).toContain('href="https://solscan.io/account/ONEMint">EXPLORER</a>');
    expect(sent[0]).toContain('href="https://fomo.family/tokens/solana/TWOMint">FOMO</a>');
    expect(sent[0]).toContain('href="https://solscan.io/account/TWOMint">EXPLORER</a>');
    runtime.stopUi();
  });

  it("honors each chat's selected digest interval", async () => {
    vi.useFakeTimers();
    try {
      const publicConfig = { ...config, telegramAdminIds: new Set<number>() };
      const state = createBotState();
      const audience = createTelegramAudience([999], "ONE_MINUTE_DIGEST", 0, 10_000, ["solana"]);
      audience.setDeliveryMode(999, "ONE_MINUTE_DIGEST");
      audience.setDigestIntervalMinutes(999, 2);
      const runtime = createTelegramBot({
        config: publicConfig,
        state,
        audience,
        digestIntervalMs: 60_000,
        logger: pino({ level: "silent" }),
      });
      const sent: string[] = [];
      runtime.bot.api.config.use(async (_previous, method, payload) => {
        if (method === "sendMessage") sent.push(String((payload as { text?: unknown }).text));
        return { ok: true, result: true } as never;
      });
      await runtime.notifier.candidateDetected({
        id: "solana:TWO_MIN",
        chain: "solana",
        source: "pumpfun",
        address: "TwoMinuteMint",
        symbol: "TWO_MIN",
        marketCapUsd: 5_000,
        discoveredAt: new Date(),
        fomoListed: false,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sent).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("2-MINUTE TOKEN DIGEST");
      runtime.stopUi();
    } finally {
      vi.useRealTimers();
    }
  });

  it("paces consecutive instant token alerts", async () => {
    vi.useFakeTimers();
    const { notifier, sent } = setup({ ...config, immediateMessageIntervalMs: 2_000 });
    const makeCandidate = (id: string) => ({
      id,
      chain: "solana" as const,
      source: "pumpfun" as const,
      address: id,
      discoveredAt: new Date(),
      fomoListed: false,
      marketCapUsd: 5_000,
    });
    await notifier.candidateDetected(makeCandidate("first"));
    const secondDelivery = notifier.candidateDetected(makeCandidate("second"));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await secondDelivery;
    expect(sent).toHaveLength(2);
    vi.useRealTimers();
  });

  it("only delivers tokens within the chat's market-cap range", async () => {
    const { bot, notifier, sent } = setup({
      ...config,
      defaultMinimumMarketCapUsd: 10_000,
      defaultMaximumMarketCapUsd: 20_000,
    });
    const candidate = {
      chain: "solana" as const,
      source: "pumpfun" as const,
      address: "mint",
      discoveredAt: new Date(),
      fomoListed: false,
    };
    await notifier.candidateDetected({ ...candidate, id: "below", marketCapUsd: 9_999 });
    expect(sent).toHaveLength(0);
    await notifier.candidateDetected({ ...candidate, id: "within", marketCapUsd: 15_000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("C: $15,000");
    await notifier.candidateDetected({ ...candidate, id: "above", marketCapUsd: 20_001 });
    expect(sent).toHaveLength(1);
    await bot.handleUpdate(commandUpdate(123, "/marketcap", 99));
    expect(sent.at(-1)).toContain("Below Min: 1");
    expect(sent.at(-1)).toContain("Above Max: 1");
  });

  it("informs an instant-delivery chat when market cap is unavailable", async () => {
    const { notifier, sent } = setup();
    const candidate = {
      chain: "solana" as const,
      source: "pumpfun" as const,
      address: "unknown-cap-mint",
      discoveredAt: new Date(),
      fomoListed: false,
    };
    await notifier.candidateDetected({ ...candidate, id: "unknown-one" });
    await notifier.candidateDetected({ ...candidate, id: "unknown-two" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("market capitalization was unavailable");
  });

  it("delivers a no-cap token once when no-cap tracking is enabled", async () => {
    const state = createBotState();
    const audience = createTelegramAudience([999], "IMMEDIATE", 0, 10_000, ["solana"]);
    audience.setTrackTokensWithoutMarketCap(999, true);
    const runtime = createTelegramBot({
      config: { ...config, telegramAdminIds: new Set<number>() },
      state,
      audience,
      logger: pino({ level: "silent" }),
    });
    const sent: string[] = [];
    runtime.bot.api.config.use(async (_previous, method, payload) => {
      if (method === "sendMessage") sent.push(String((payload as { text?: unknown }).text));
      return { ok: true, result: true } as never;
    });
    const candidate = {
      id: "solana:no-cap",
      chain: "solana" as const,
      source: "pumpfun" as const,
      address: "NoCapMint",
      discoveredAt: new Date(),
      fomoListed: false,
    };
    await runtime.notifier.candidateDetected(candidate);
    await runtime.notifier.candidateUpdated(candidate);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("C: Unavailable");
    runtime.stopUi();
  });
});

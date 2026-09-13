import { Bot, GrammyError, HttpError, type Context, type InlineKeyboard } from "grammy";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { Chain, TokenCandidate } from "../domain/token-candidate.js";
import { chainLabel, formatCandidate, formatCandidateDigestPages, formatLightCandidate, formatStatus } from "./formatters.js";
import {
  candidateKeyboard,
  chainsKeyboard,
  deliveryKeyboard,
  isChain,
  lightDigestKeyboard,
  mainMenuKeyboard,
  marketCapKeyboard,
} from "./keyboards.js";
import {
  basicHealthService,
  createCandidateDigestQueue,
  createTelegramAudience,
  createCandidateStore,
  type CandidateDigestQueue,
  type CandidateStore,
  DIGEST_INTERVAL_MINUTES,
  type DigestIntervalMinutes,
  type HealthService,
  type TelegramAudience,
} from "./services.js";
import type { BotState } from "./state.js";

const HELP = [
  "<b>Available commands</b>",
  "",
  "/status — runtime and discovery status",
  "/health — dependency health",
  "/delivery — choose instant alerts or a timed digest",
  "/marketcap — set the token market-cap range",
  "/menu — open the control menu",
  "/stop — unsubscribe from token alerts",
  "/chains — choose discovery chains for this chat",
  "/help — show this message",
].join("\n");

export const TELEGRAM_COMMANDS = [
  { command: "start", description: "Subscribe and open the main menu" },
  { command: "menu", description: "Open the bot control menu" },
  { command: "status", description: "Show runtime and discovery status" },
  { command: "health", description: "Show detector and dependency health" },
  { command: "delivery", description: "Choose instant alerts or a timed digest" },
  { command: "marketcap", description: "Set token market-cap range" },
  { command: "help", description: "Show command help" },
  { command: "stop", description: "Unsubscribe from token alerts" },
  { command: "chains", description: "Choose this chat's discovery chains" },
  { command: "enable_solana", description: "Enable Solana for this chat" },
  { command: "enable_bsc", description: "Enable BSC for this chat" },
  { command: "enable_base", description: "Enable Base for this chat" },
  { command: "enable_robinhood", description: "Enable Robinhood for this chat" },
] as const;

export interface TelegramBotDependencies {
  config: AppConfig;
  state: BotState;
  logger: Logger;
  healthService?: HealthService;
  candidateStore?: CandidateStore;
  audience?: TelegramAudience;
  digestQueue?: CandidateDigestQueue;
  digestIntervalMs?: number;
  holderRefresher?: { refresh(candidate: TokenCandidate): Promise<TokenCandidate> };
  candidateView?: (candidate: TokenCandidate, chatId: number) => TokenCandidate;
}

export interface TelegramNotifier {
  candidateDetected(candidate: TokenCandidate): Promise<void>;
  candidateUpdated(candidate: TokenCandidate): Promise<void>;
  tradeUpdated(message: string): Promise<void>;
}

export interface TelegramBotRuntime {
  bot: Bot;
  notifier: TelegramNotifier;
  configureUi(): Promise<void>;
  flushDigests(): Promise<void>;
  stopUi(): void;
}

export function parseMarketCapInput(input: string): number | undefined {
  const match = input.trim().toUpperCase().replaceAll(",", "").match(/^\$?\s*([0-9]+(?:\.[0-9]+)?)\s*([KM]?)$/);
  if (!match?.[1]) return undefined;
  const amount = Number(match[1]);
  const multiplier = match[2] === "K" ? 1_000 : match[2] === "M" ? 1_000_000 : 1;
  const value = amount * multiplier;
  return Number.isFinite(value) && value >= 0 && value <= 1_000_000_000_000 ? value : undefined;
}

function healthText(report: Awaited<ReturnType<HealthService["check"]>>): string {
  const icon = { up: "✅", down: "❌", not_configured: "➖" } as const;
  const checks = Object.entries(report.checks).map(([name, status]) => `${icon[status]} ${name}: ${status}`);
  return [`<b>Health: ${report.status.toUpperCase()}</b>`, "", ...checks].join("\n");
}

function missingMarketCapNotice(count: number): string {
  return [
    "ℹ️ <b>Market-cap filter notice</b>",
    "",
    `${count} detected token${count === 1 ? " was" : "s were"} skipped because market capitalization was unavailable.`,
    "The bot will keep monitoring Pump.fun reserve updates and can deliver the token later if its cap becomes available within your range.",
  ].join("\n");
}

async function editOrReply(ctx: Context, text: string, options?: { reply_markup: InlineKeyboard }): Promise<void> {
  if (ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, { parse_mode: "HTML", ...options }).catch(async (error: unknown) => {
      if (error instanceof GrammyError && error.description.includes("message is not modified")) return;
      throw error;
    });
    return;
  }
  await ctx.reply(text, { parse_mode: "HTML", ...options });
}

export function createTelegramBot(dependencies: TelegramBotDependencies): TelegramBotRuntime {
  const { config, state, logger } = dependencies;
  const health = dependencies.healthService ?? basicHealthService;
  const candidates = dependencies.candidateStore ?? createCandidateStore();
  const audience = dependencies.audience ?? createTelegramAudience(
    config.telegramAdminIds,
    config.defaultDeliveryMode,
    config.defaultMinimumMarketCapUsd,
    config.defaultMaximumMarketCapUsd,
    config.enabledChains,
  );
  const digestQueue = dependencies.digestQueue ?? createCandidateDigestQueue();
  const holderRefresher = dependencies.holderRefresher;
  const candidateView = dependencies.candidateView ?? ((candidate: TokenCandidate) => candidate);
  const digestIntervalMs = dependencies.digestIntervalMs ?? 60_000;
  const bot = new Bot(config.telegramToken);
  const immediateDeliveryChains = new Map<number, Promise<void>>();
  const lastImmediateDeliveryAt = new Map<number, number>();
  const digestPeriodsStartedAt = new Map<number, number>();
  const awaitingMarketCapInput = new Map<number, "min" | "max">();
  const missingMarketCapCounts = new Map<number, number>();
  const lastMissingMarketCapNoticeAt = new Map<number, number>();
  const filterStats = new Map<number, { below: number; above: number; unavailable: number }>();
  const recordFiltered = (chatId: number, reason: "below" | "above" | "unavailable") => {
    const stats = filterStats.get(chatId) ?? { below: 0, above: 0, unavailable: 0 };
    stats[reason] += 1;
    filterStats.set(chatId, stats);
  };
  const marketCapScreen = (chatId: number) => {
    const minimum = audience.minimumMarketCapUsd(chatId);
    const maximum = audience.maximumMarketCapUsd(chatId);
    const stats = filterStats.get(chatId) ?? { below: 0, above: 0, unavailable: 0 };
    return [
      "<b>Market-cap range</b>",
      "",
      `Min: <b>$${minimum.toLocaleString("en-US")}</b>`,
      `Max: <b>$${maximum.toLocaleString("en-US")}</b>`,
      "",
      "<b>Filtered since restart</b>",
      `Below Min: ${stats.below}`,
      `Above Max: ${stats.above}`,
      `Cap unavailable: ${stats.unavailable}`,
      `Track without cap: <b>${audience.trackTokensWithoutMarketCap(chatId) ? "ON" : "OFF"}</b>`,
    ].join("\n");
  };
  const wasDelivered = (chatId: number, candidateId: string) =>
    audience.wasCandidateDelivered(chatId, candidateId);
  const markDelivered = (chatId: number, candidateIds: readonly string[]) => {
    candidateIds.forEach((candidateId) => audience.markCandidateDelivered(chatId, candidateId));
  };
  const removeQueuedChain = (chatId: number, chain: Chain) => {
    const retained = digestQueue.drain(chatId).filter((candidate) => candidate.chain !== chain);
    retained.forEach((candidate) => digestQueue.enqueue(chatId, candidate));
  };

  const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  const sendPaced = (chatId: number, send: () => Promise<void>): Promise<void> => {
    const previous = immediateDeliveryChains.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const elapsed = Date.now() - (lastImmediateDeliveryAt.get(chatId) ?? 0);
      const delay = Math.max(0, config.immediateMessageIntervalMs - elapsed);
      if (delay > 0) await wait(delay);
      await send();
      lastImmediateDeliveryAt.set(chatId, Date.now());
    });
    immediateDeliveryChains.set(chatId, next);
    const cleanUp = () => {
      if (immediateDeliveryChains.get(chatId) === next) immediateDeliveryChains.delete(chatId);
    };
    void next.then(cleanUp, cleanUp);
    return next;
  };

  const menuKeyboardFor = (ctx: Context) => mainMenuKeyboard({
    subscribed: ctx.chat !== undefined && audience.isSubscribed(ctx.chat.id),
    deliveryMode: ctx.chat === undefined ? "IMMEDIATE" : audience.deliveryMode(ctx.chat.id),
    digestIntervalMinutes: ctx.chat === undefined ? 1 : audience.digestIntervalMinutes(ctx.chat.id),
    minimumMarketCapUsd: ctx.chat === undefined
      ? config.defaultMinimumMarketCapUsd
      : audience.minimumMarketCapUsd(ctx.chat.id),
    maximumMarketCapUsd: ctx.chat === undefined
      ? config.defaultMaximumMarketCapUsd
      : audience.maximumMarketCapUsd(ctx.chat.id),
    showHolders: ctx.chat === undefined || audience.showHolders(ctx.chat.id),
    showCreatorHistory: ctx.chat !== undefined && audience.showCreatorHistory(ctx.chat.id),
    messageFormat: ctx.chat === undefined ? "LIGHT" : audience.messageFormat(ctx.chat.id),
  });
  const statusFor = (ctx: Context) => formatStatus(
    state.snapshot(),
    ctx.chat === undefined ? config.enabledChains : audience.enabledChains(ctx.chat.id),
  );

  const showMainMenu = async (ctx: Context, edit = false): Promise<void> => {
    const text = "<b>Multi-Chain Pre-FOMO Bot</b>\n\nChoose an action:";
    if (edit && ctx.callbackQuery?.message) {
      await editOrReply(ctx, text, { reply_markup: menuKeyboardFor(ctx) });
      return;
    }
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: menuKeyboardFor(ctx) });
  };

  bot.command("start", async (ctx) => {
    audience.clearCandidateDeliveryHistory(ctx.chat.id);
    audience.subscribe(ctx.chat.id);
    await ctx.reply(
      ["<b>Multi-Chain Pre-FOMO Bot</b>", "", "✅ You are subscribed to token alerts.", "On-chain token discovery is ready.", "The bot operates in Discovery Only mode."].join("\n"),
      { parse_mode: "HTML", reply_markup: menuKeyboardFor(ctx) },
    );
  });
  bot.command("menu", (ctx) => showMainMenu(ctx));
  bot.command("stop", async (ctx) => {
    audience.clearCandidateDeliveryHistory(ctx.chat.id);
    audience.unsubscribe(ctx.chat.id);
    digestQueue.drain(ctx.chat.id);
    digestPeriodsStartedAt.delete(ctx.chat.id);
    missingMarketCapCounts.delete(ctx.chat.id);
    lastMissingMarketCapNoticeAt.delete(ctx.chat.id);
    filterStats.delete(ctx.chat.id);
    await ctx.reply("You are unsubscribed from token alerts. Send /start to subscribe again.", {
      reply_markup: menuKeyboardFor(ctx),
    });
  });
  bot.command("help", (ctx) => ctx.reply(HELP, { parse_mode: "HTML", reply_markup: menuKeyboardFor(ctx) }));
  bot.command("status", (ctx) => ctx.reply(statusFor(ctx), {
    parse_mode: "HTML",
    reply_markup: menuKeyboardFor(ctx),
  }));
  bot.command("health", async (ctx) => ctx.reply(healthText(await health.check()), {
    parse_mode: "HTML",
    reply_markup: menuKeyboardFor(ctx),
  }));
  bot.command("delivery", async (ctx) => {
    await ctx.reply("<b>Token delivery mode</b>\n\nChoose how this chat receives new-token alerts:", {
      parse_mode: "HTML",
      reply_markup: deliveryKeyboard(audience.deliveryMode(ctx.chat.id), audience.digestIntervalMinutes(ctx.chat.id)),
    });
  });
  bot.command("marketcap", async (ctx) => {
    await ctx.reply(marketCapScreen(ctx.chat.id), {
      parse_mode: "HTML",
      reply_markup: marketCapKeyboard(audience.trackTokensWithoutMarketCap(ctx.chat.id)),
    });
  });
  bot.command("chains", async (ctx) => {
    await ctx.reply("<b>Discovery chains for this chat</b>", {
      parse_mode: "HTML",
      reply_markup: chainsKeyboard(audience.enabledChains(ctx.chat.id)),
    });
  });
  for (const chain of ["solana", "bsc", "base", "robinhood"] as const) {
    bot.command(`enable_${chain}`, async (ctx) => {
      audience.setChainEnabled(ctx.chat.id, chain, true);
      await ctx.reply(statusFor(ctx), { parse_mode: "HTML" });
    });
  }

  bot.callbackQuery("menu:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showMainMenu(ctx, true);
  });
  bot.callbackQuery("menu:status", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, statusFor(ctx), { reply_markup: menuKeyboardFor(ctx) });
  });
  bot.callbackQuery("menu:health", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, healthText(await health.check()), { reply_markup: menuKeyboardFor(ctx) });
  });
  bot.callbackQuery("menu:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, HELP, { reply_markup: menuKeyboardFor(ctx) });
  });
  bot.callbackQuery("menu:delivery", async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, "<b>Token delivery mode</b>\n\nChoose how this chat receives new-token alerts:", {
      reply_markup: deliveryKeyboard(
        audience.deliveryMode(ctx.chat?.id ?? 0),
        audience.digestIntervalMinutes(ctx.chat?.id ?? 0),
      ),
    });
  });
  bot.callbackQuery("menu:marketcap", async (ctx) => {
    if (!ctx.chat) return ctx.answerCallbackQuery({ text: "Chat is unavailable", show_alert: true });
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, marketCapScreen(ctx.chat.id), {
      reply_markup: marketCapKeyboard(audience.trackTokensWithoutMarketCap(ctx.chat.id)),
    });
  });
  bot.callbackQuery(/^marketcap:set:(min|max)$/, async (ctx) => {
    if (!ctx.chat) return ctx.answerCallbackQuery({ text: "Chat is unavailable", show_alert: true });
    const boundary = ctx.match[1] as "min" | "max";
    awaitingMarketCapInput.set(ctx.chat.id, boundary);
    await ctx.answerCallbackQuery();
    await ctx.reply(`Enter the ${boundary === "min" ? "minimum" : "maximum"} market cap in USD (examples: 10000, $25,000, 50K, or 1M):`, {
      reply_markup: { force_reply: true },
    });
  });
  bot.callbackQuery("marketcap:unknown:toggle", async (ctx) => {
    if (!ctx.chat) return ctx.answerCallbackQuery({ text: "Chat is unavailable", show_alert: true });
    const enabled = !audience.trackTokensWithoutMarketCap(ctx.chat.id);
    audience.setTrackTokensWithoutMarketCap(ctx.chat.id, enabled);
    await ctx.answerCallbackQuery({ text: `Tracking tokens without cap ${enabled ? "enabled" : "disabled"}` });
    await editOrReply(ctx, marketCapScreen(ctx.chat.id), {
      reply_markup: marketCapKeyboard(enabled),
    });
  });
  bot.callbackQuery("holders:toggle", async (ctx) => {
    if (!ctx.chat) return ctx.answerCallbackQuery({ text: "Chat is unavailable", show_alert: true });
    const enabled = !audience.showHolders(ctx.chat.id);
    audience.setShowHolders(ctx.chat.id, enabled);
    await ctx.answerCallbackQuery({ text: `Holder details ${enabled ? "enabled" : "disabled"}` });
    await showMainMenu(ctx, true);
  });
  bot.callbackQuery("creator_history:toggle", async (ctx) => {
    if (!ctx.chat) return ctx.answerCallbackQuery({ text: "Chat is unavailable", show_alert: true });
    const enabled = !audience.showCreatorHistory(ctx.chat.id);
    audience.setShowCreatorHistory(ctx.chat.id, enabled);
    await ctx.answerCallbackQuery({ text: `Creator history ${enabled ? "enabled" : "disabled"}` });
    await showMainMenu(ctx, true);
  });
  bot.callbackQuery("message_format:toggle", async (ctx) => {
    if (!ctx.chat) return ctx.answerCallbackQuery({ text: "Chat is unavailable", show_alert: true });
    const format = audience.messageFormat(ctx.chat.id) === "FULL" ? "LIGHT" : "FULL";
    audience.setMessageFormat(ctx.chat.id, format);
    await ctx.answerCallbackQuery({ text: `Message format set to ${format}` });
    await showMainMenu(ctx, true);
  });
  bot.callbackQuery("menu:subscribe", async (ctx) => {
    if (ctx.chat) {
      audience.clearCandidateDeliveryHistory(ctx.chat.id);
      audience.subscribe(ctx.chat.id);
    }
    await ctx.answerCallbackQuery({ text: "Subscribed to token alerts" });
    await showMainMenu(ctx, true);
  });
  bot.callbackQuery("menu:unsubscribe", async (ctx) => {
    if (ctx.chat) {
      audience.clearCandidateDeliveryHistory(ctx.chat.id);
      audience.unsubscribe(ctx.chat.id);
      digestQueue.drain(ctx.chat.id);
      digestPeriodsStartedAt.delete(ctx.chat.id);
      missingMarketCapCounts.delete(ctx.chat.id);
      lastMissingMarketCapNoticeAt.delete(ctx.chat.id);
      filterStats.delete(ctx.chat.id);
    }
    await ctx.answerCallbackQuery({ text: "Unsubscribed from token alerts" });
    await showMainMenu(ctx, true);
  });
  bot.callbackQuery("menu:chains", async (ctx) => {
    if (!ctx.chat) return ctx.answerCallbackQuery({ text: "Chat is unavailable", show_alert: true });
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, "<b>Discovery chains for this chat</b>", {
      reply_markup: chainsKeyboard(audience.enabledChains(ctx.chat.id)),
    });
  });
  bot.callbackQuery(/^delivery:(IMMEDIATE|ONE_MINUTE_DIGEST)$/, async (ctx) => {
    if (!ctx.chat) return ctx.answerCallbackQuery({ text: "Chat is unavailable", show_alert: true });
    const mode = ctx.match[1] as "IMMEDIATE" | "ONE_MINUTE_DIGEST";
    audience.setDeliveryMode(ctx.chat.id, mode);
    if (mode === "IMMEDIATE") {
      digestQueue.drain(ctx.chat.id);
      digestPeriodsStartedAt.delete(ctx.chat.id);
    } else {
      digestPeriodsStartedAt.set(ctx.chat.id, Date.now());
    }
    const interval = audience.digestIntervalMinutes(ctx.chat.id);
    await ctx.answerCallbackQuery({
      text: mode === "IMMEDIATE" ? "Instant alerts enabled" : `${interval}-minute digest enabled`,
    });
    await editOrReply(ctx, "<b>Token delivery mode</b>\n\nPreference saved for this chat.", {
      reply_markup: deliveryKeyboard(mode, interval),
    });
  });

  bot.callbackQuery(/^digest_interval:(1|2|5|10)$/, async (ctx) => {
    if (!ctx.chat) return ctx.answerCallbackQuery({ text: "Chat is unavailable", show_alert: true });
    const minutes = Number(ctx.match[1]) as DigestIntervalMinutes;
    if (!DIGEST_INTERVAL_MINUTES.includes(minutes)) {
      return ctx.answerCallbackQuery({ text: "Unsupported digest interval", show_alert: true });
    }
    audience.setDigestIntervalMinutes(ctx.chat.id, minutes);
    audience.setDeliveryMode(ctx.chat.id, "ONE_MINUTE_DIGEST");
    digestPeriodsStartedAt.set(ctx.chat.id, Date.now());
    await ctx.answerCallbackQuery({ text: `${minutes}-minute digest enabled` });
    await editOrReply(ctx, "<b>Token delivery mode</b>\n\nPreference saved for this chat.", {
      reply_markup: deliveryKeyboard("ONE_MINUTE_DIGEST", minutes),
    });
  });

  bot.callbackQuery(/^chain:(.+)$/, async (ctx) => {
    if (!ctx.chat) return ctx.answerCallbackQuery({ text: "Chat is unavailable", show_alert: true });
    const chain = ctx.match[1];
    if (!chain || !isChain(chain)) return ctx.answerCallbackQuery({ text: "Unknown chain", show_alert: true });
    const enabled = !audience.enabledChains(ctx.chat.id).includes(chain);
    audience.setChainEnabled(ctx.chat.id, chain, enabled);
    if (!enabled) removeQueuedChain(ctx.chat.id, chain);
    await ctx.answerCallbackQuery({ text: `${chainLabel(chain)} ${enabled ? "enabled" : "disabled"}` });
    await editOrReply(ctx, "<b>Discovery chains for this chat</b>", {
      reply_markup: chainsKeyboard(audience.enabledChains(ctx.chat.id)),
    });
  });

  bot.on("message:text", async (ctx) => {
    const boundary = awaitingMarketCapInput.get(ctx.chat.id);
    if (!boundary) return;
    const value = parseMarketCapInput(ctx.message.text);
    if (value === undefined) {
      await ctx.reply("Invalid amount. Enter a value such as 10000, $25,000, 50K, or 1M.", {
        reply_markup: { force_reply: true },
      });
      return;
    }
    const minimum = audience.minimumMarketCapUsd(ctx.chat.id);
    const maximum = audience.maximumMarketCapUsd(ctx.chat.id);
    if (boundary === "min" && value > maximum) {
      await ctx.reply(`Minimum cannot exceed the current maximum of $${maximum.toLocaleString("en-US")}. Set Max first or enter a lower Min.`, {
        reply_markup: { force_reply: true },
      });
      return;
    }
    if (boundary === "max" && value < minimum) {
      await ctx.reply(`Maximum cannot be below the current minimum of $${minimum.toLocaleString("en-US")}. Set Min first or enter a higher Max.`, {
        reply_markup: { force_reply: true },
      });
      return;
    }
    awaitingMarketCapInput.delete(ctx.chat.id);
    if (boundary === "min") audience.setMinimumMarketCapUsd(ctx.chat.id, value);
    else audience.setMaximumMarketCapUsd(ctx.chat.id, value);
    await ctx.reply(`✅ ${boundary === "min" ? "Minimum" : "Maximum"} market cap set to $${value.toLocaleString("en-US")}.`, {
      reply_markup: menuKeyboardFor(ctx),
    });
  });

  bot.callbackQuery(/^details:(.+)$/, async (ctx) => {
    const candidate = candidates.get(ctx.match[1] ?? "");
    if (!candidate) return ctx.answerCallbackQuery({ text: "Candidate is no longer available", show_alert: true });
    if (!ctx.chat) return ctx.answerCallbackQuery({ text: "Chat is unavailable", show_alert: true });
    await ctx.answerCallbackQuery();
    await ctx.reply(formatCandidate(candidateView(candidate, ctx.chat.id), new Date(), {
      showHolders: audience.showHolders(ctx.chat.id),
      showCreatorHistory: audience.showCreatorHistory(ctx.chat.id),
    }), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });
  bot.callbackQuery(/^holders:(.+)$/, async (ctx) => {
    const candidate = candidates.get(ctx.match[1] ?? "");
    if (!candidate) return ctx.answerCallbackQuery({ text: "Candidate is no longer available", show_alert: true });
    if (!ctx.chat) return ctx.answerCallbackQuery({ text: "Chat is unavailable", show_alert: true });
    await ctx.answerCallbackQuery({ text: "Refreshing holder positions…" });
    try {
      const refreshed = holderRefresher ? await holderRefresher.refresh(candidate) : candidate;
      candidates.put(refreshed);
      await ctx.reply(formatCandidate(candidateView(refreshed, ctx.chat.id), new Date(), {
        showHolders: true,
        showCreatorHistory: audience.showCreatorHistory(ctx.chat.id),
      }), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: candidateKeyboard(refreshed),
      });
    } catch (error) {
      logger.warn({ err: error, candidateId: candidate.id }, "Holder refresh failed");
      await ctx.reply("Holder data could not be refreshed right now. Please try again shortly.");
    }
  });
  bot.callbackQuery(/^ignore:(.+)$/, async (ctx) => {
    candidates.ignore(ctx.match[1] ?? "");
    await ctx.answerCallbackQuery({ text: "Candidate ignored" });
    await ctx.editMessageReplyMarkup();
  });
  bot.catch((error) => {
    const cause = error.error;
    if (cause instanceof GrammyError) logger.error({ description: cause.description }, "Telegram API error");
    else if (cause instanceof HttpError) logger.error({ err: cause }, "Telegram transport error");
    else logger.error({ err: cause }, "Telegram handler error");
  });

  const sendToRecipients = async (
    recipients: readonly number[],
    text: string | ((chatId: number) => string),
    candidate?: TokenCandidate,
    paced = false,
  ): Promise<void> => {
    const results = await Promise.allSettled(
      recipients.map(async (chatId) => {
        const send = () => {
          if (candidate && !audience.enabledChains(chatId).includes(candidate.chain)) return Promise.resolve();
          return bot.api.sendMessage(chatId, typeof text === "function" ? text(chatId) : text, {
            parse_mode: "HTML",
            ...(candidate ? { link_preview_options: { is_disabled: true } } : {}),
            ...(candidate ? {
              reply_markup: candidateKeyboard(candidate, audience.messageFormat(chatId) === "LIGHT"),
            } : {}),
          }).then(() => undefined);
        };
        if (paced) await sendPaced(chatId, send);
        else await send();
      }),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        logger.error({ err: result.reason, chatId: recipients[index] }, "Telegram notification failed");
      }
    });
    if (results.length > 0 && results.every((result) => result.status === "rejected")) {
      throw new AggregateError(
        results.map((result) => (result.status === "rejected" ? result.reason : undefined)),
        "Telegram notification failed for every subscriber",
      );
    }
  };

  const sendToAudience = (text: string, candidate?: TokenCandidate) =>
    sendToRecipients(audience.chatIds(), text, candidate);

  const flushDigestsFor = async (digestRecipients: readonly number[]): Promise<void> => {
    await Promise.all(digestRecipients.map(async (chatId) => {
      const queued = digestQueue.drain(chatId).filter((candidate) =>
        audience.enabledChains(chatId).includes(candidate.chain));
      const missingMarketCaps = missingMarketCapCounts.get(chatId) ?? 0;
      if (queued.length === 0 && missingMarketCaps === 0) return;
      try {
        if (queued.length > 0) {
          const messageFormat = audience.messageFormat(chatId);
          const pages = formatCandidateDigestPages(
            queued.map((candidate) => candidateView(candidate, chatId)),
            new Date(),
            audience.digestIntervalMinutes(chatId),
            {
              showHolders: audience.showHolders(chatId),
              showCreatorHistory: audience.showCreatorHistory(chatId),
              messageFormat,
            },
          );
          for (const page of pages) {
            await bot.api.sendMessage(chatId, page.text, {
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
              ...(messageFormat === "LIGHT" && page.candidates.length > 0
                ? { reply_markup: lightDigestKeyboard(page.candidates) }
                : {}),
            });
          }
          markDelivered(chatId, queued.map((candidate) => candidate.id));
        }
        if (missingMarketCaps > 0) {
          await bot.api.sendMessage(chatId, missingMarketCapNotice(missingMarketCaps), { parse_mode: "HTML" });
          missingMarketCapCounts.delete(chatId);
          lastMissingMarketCapNoticeAt.set(chatId, Date.now());
        }
      } catch (error) {
        queued.forEach((candidate) => digestQueue.enqueue(chatId, candidate));
        logger.error({ err: error, chatId, candidates: queued.length }, "Telegram digest delivery failed");
      }
    }));
  };

  const flushDigests = async (): Promise<void> => {
    const recipients = audience.chatIds().filter(
      (chatId) => audience.deliveryMode(chatId) === "ONE_MINUTE_DIGEST",
    );
    await flushDigestsFor(recipients);
    recipients.forEach((chatId) => digestPeriodsStartedAt.set(chatId, Date.now()));
  };

  const flushDueDigests = async (): Promise<void> => {
    const now = Date.now();
    const due = audience.chatIds().filter((chatId) => {
      if (audience.deliveryMode(chatId) !== "ONE_MINUTE_DIGEST") return false;
      const startedAt = digestPeriodsStartedAt.get(chatId);
      if (startedAt === undefined) return false;
      return now - startedAt >= audience.digestIntervalMinutes(chatId) * 60_000;
    });
    await flushDigestsFor(due);
    due.forEach((chatId) => digestPeriodsStartedAt.set(chatId, now));
  };

  const digestTimer = setInterval(() => {
    void flushDueDigests().catch((error: unknown) => logger.error({ err: error }, "Telegram digest flush failed"));
  }, digestIntervalMs);
  digestTimer.unref();

  const routeCandidate = async (candidate: TokenCandidate): Promise<void> => {
    const immediateText = (chatId: number) => {
      const view = candidateView(candidate, chatId);
      return audience.messageFormat(chatId) === "LIGHT"
        ? formatLightCandidate(view)
        : formatCandidate(view, new Date(), {
            showHolders: audience.showHolders(chatId),
            showCreatorHistory: audience.showCreatorHistory(chatId),
          });
    };
    if (candidate.marketCapUsd === undefined) {
      const now = Date.now();
      const subscribers = audience.chatIds().filter((chatId) => audience.enabledChains(chatId).includes(candidate.chain));
      const trackedRecipients = subscribers.filter((chatId) =>
        audience.trackTokensWithoutMarketCap(chatId) && !wasDelivered(chatId, candidate.id));
      const excludedRecipients = subscribers.filter((chatId) => !audience.trackTokensWithoutMarketCap(chatId));
      excludedRecipients.forEach((chatId) => {
        recordFiltered(chatId, "unavailable");
        missingMarketCapCounts.set(chatId, (missingMarketCapCounts.get(chatId) ?? 0) + 1);
        if (audience.deliveryMode(chatId) === "ONE_MINUTE_DIGEST" && !digestPeriodsStartedAt.has(chatId)) {
          digestPeriodsStartedAt.set(chatId, now);
        }
      });
      const immediateNotices = excludedRecipients.filter((chatId) =>
        audience.deliveryMode(chatId) === "IMMEDIATE" &&
        now - (lastMissingMarketCapNoticeAt.get(chatId) ?? 0) >= 60_000);
      await Promise.all(immediateNotices.map(async (chatId) => {
        const count = missingMarketCapCounts.get(chatId) ?? 0;
        await sendToRecipients([chatId], missingMarketCapNotice(count));
        missingMarketCapCounts.delete(chatId);
        lastMissingMarketCapNoticeAt.set(chatId, now);
      }));
      const digestRecipients = trackedRecipients.filter(
        (chatId) => audience.deliveryMode(chatId) === "ONE_MINUTE_DIGEST",
      );
      digestRecipients.forEach((chatId) => {
        digestQueue.enqueue(chatId, candidate);
        if (!digestPeriodsStartedAt.has(chatId)) digestPeriodsStartedAt.set(chatId, now);
      });
      const immediateRecipients = trackedRecipients.filter(
        (chatId) => audience.deliveryMode(chatId) === "IMMEDIATE",
      );
      await sendToRecipients(immediateRecipients, immediateText, candidate, true);
      immediateRecipients.forEach((chatId) => markDelivered(chatId, [candidate.id]));
      return;
    }
    const marketCapUsd = candidate.marketCapUsd;
    const recipients = audience.chatIds().filter((chatId) => {
      if (!audience.enabledChains(chatId).includes(candidate.chain)) return false;
      if (marketCapUsd < audience.minimumMarketCapUsd(chatId)) {
        recordFiltered(chatId, "below");
        return false;
      }
      if (marketCapUsd > audience.maximumMarketCapUsd(chatId)) {
        recordFiltered(chatId, "above");
        return false;
      }
      return !wasDelivered(chatId, candidate.id);
    });
    const immediateRecipients = recipients.filter((chatId) => audience.deliveryMode(chatId) === "IMMEDIATE");
    recipients
      .filter((chatId) => audience.deliveryMode(chatId) === "ONE_MINUTE_DIGEST")
      .forEach((chatId) => {
        digestQueue.enqueue(chatId, candidate);
        if (!digestPeriodsStartedAt.has(chatId)) digestPeriodsStartedAt.set(chatId, Date.now());
      });
    await sendToRecipients(immediateRecipients, immediateText, candidate, true);
    immediateRecipients.forEach((chatId) => markDelivered(chatId, [candidate.id]));
  };

  return {
    bot,
    async configureUi() {
      await Promise.all([
        bot.api.setMyCommands([...TELEGRAM_COMMANDS]),
        bot.api.setChatMenuButton({ menu_button: { type: "commands" } }),
      ]);
    },
    flushDigests,
    stopUi() {
      clearInterval(digestTimer);
    },
    notifier: {
      async candidateDetected(candidate) {
        candidates.put(candidate);
        state.recordDetection();
        await routeCandidate(candidate);
      },
      async candidateUpdated(candidate) {
        candidates.put(candidate);
        await routeCandidate(candidate);
      },
      async tradeUpdated(message) {
        await sendToAudience(message);
      },
    },
  };
}

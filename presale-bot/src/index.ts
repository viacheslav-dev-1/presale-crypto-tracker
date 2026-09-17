import { loadConfig } from "./config.js";
import { createTelegramBot } from "./bot/bot.js";
import { createBotState } from "./bot/state.js";
import { createLogger } from "./logger.js";
import { createEventBus } from "./events/event-bus.js";
import { createInMemoryCandidateRepository } from "./candidates/repository.js";
import { registerCandidatePipeline } from "./candidates/pipeline.js";
import { createSolanaConnection } from "./chains/solana/connection.js";
import { PumpFunDetector } from "./chains/solana/pumpfun/detector.js";
import { createPersistentTelegramAudience } from "./bot/services.js";
import { createSolUsdPriceService } from "./chains/solana/pumpfun/market-cap.js";
import { GrammyError } from "grammy";
import { acquireProcessLock } from "./process-lock.js";
import { createEvmClient } from "./chains/evm/client.js";
import { EvmDexDetector } from "./chains/evm/detector.js";
import { createBnbUsdPriceService, createEthUsdPriceService } from "./chains/evm/market-data.js";
import { withTokenRisk } from "./risk/risk-engine.js";
import { createCreatorHistoryService, createHeliusCreatorFundingProvider, gateCreatorHistory } from "./creators/history.js";

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function main(): Promise<void> {
  const config = loadConfig();
  const releaseProcessLock = acquireProcessLock(".data/presale-bot.lock");
  process.once("exit", releaseProcessLock);
  const logger = createLogger(config);
  const state = createBotState();
  const eventBus = createEventBus();
  const repository = createInMemoryCandidateRepository();
  const creatorHistory = createCreatorHistoryService({
    logger,
    filePath: config.creatorHistoryFile,
    meaningfulLiquidityUsd: config.creatorMeaningfulLiquidityUsd,
    ...(config.solana.heliusApiKey
      ? { fundingProvider: createHeliusCreatorFundingProvider(config.solana.heliusApiKey) }
      : {}),
  });
  const audience = createPersistentTelegramAudience(
    config.telegramAudienceFile,
    config.telegramAdminIds,
    config.defaultDeliveryMode,
    config.defaultMinimumMarketCapUsd,
    config.defaultMaximumMarketCapUsd,
    config.telegramDeliveryHistoryFile,
    config.enabledChains,
  );
  const gatedCreatorHistory = gateCreatorHistory(
    creatorHistory,
    () => audience.chatIds().some((chatId) => audience.showCreatorHistory(chatId)),
  );
  const isDiscoveryEnabled = () => audience.chatIds().length > 0;
  const candidateView = (candidate: Parameters<typeof withTokenRisk>[0], chatId: number) => {
    if (audience.showCreatorHistory(chatId) || !candidate.creatorHistory) return candidate;
    const { creatorHistory: _history, riskScore: _score, riskAssessment: _assessment, ...withoutHistory } = candidate;
    return withTokenRisk(withoutHistory);
  };
  const pumpDetector = config.solana.rpcHttp
    ? new PumpFunDetector({
        connection: createSolanaConnection(config.solana),
        programId: config.solana.pumpProgramId,
        commitment: config.solana.commitment,
        eventBus,
        logger,
        ...(config.solana.heliusApiKey ? { heliusApiKey: config.solana.heliusApiKey } : {}),
        solUsdPrice: createSolUsdPriceService(),
        isDiscoveryEnabled,
      })
    : undefined;
  const bscDetector = config.bsc
    ? new EvmDexDetector({
        config: config.bsc,
        client: createEvmClient(config.bsc),
        eventBus,
        logger,
        nativeUsdPrice: createBnbUsdPriceService(),
        isDiscoveryEnabled,
      })
    : undefined;
  const baseDetector = config.base
    ? new EvmDexDetector({
        config: config.base,
        client: createEvmClient(config.base),
        eventBus,
        logger,
        nativeUsdPrice: createEthUsdPriceService(),
        isDiscoveryEnabled,
      })
    : undefined;
  const robinhoodDetector = new EvmDexDetector({
    config: config.robinhood,
    client: createEvmClient(config.robinhood),
    eventBus,
    logger,
    nativeUsdPrice: createEthUsdPriceService(),
    isDiscoveryEnabled,
  });
  const healthService = {
    async check() {
      const detectorStatus = pumpDetector?.status();
      const solanaStatus = !pumpDetector
        ? "not_configured" as const
        : detectorStatus?.running ? "up" as const : "down" as const;
      const robinhoodStatus = robinhoodDetector.status().running ? "up" as const : "down" as const;
      const bscStatus = !bscDetector
        ? "not_configured" as const
        : bscDetector.status().running ? "up" as const : "down" as const;
      const baseStatus = !baseDetector
        ? "not_configured" as const
        : baseDetector.status().running ? "up" as const : "down" as const;
      return {
        status: solanaStatus === "down" || bscStatus === "down" || baseStatus === "down" || robinhoodStatus === "down"
          ? "degraded" as const
          : "ok" as const,
        checks: {
          process: "up" as const,
          telegram: "up" as const,
          pumpDetector: solanaStatus,
          bscDetector: bscStatus,
          baseDetector: baseStatus,
          robinhoodDetector: robinhoodStatus,
          database: "not_configured" as const,
          redis: "not_configured" as const,
        },
      };
    },
  };
  const { bot, notifier, configureUi, stopUi } = createTelegramBot({
    config,
    state,
    logger,
    healthService,
    audience,
    holderRefresher: {
      async refresh(candidate) {
        if (candidate.chain === "solana" && pumpDetector) {
          return withTokenRisk(await gatedCreatorHistory.enrich(await pumpDetector.refreshHolders(candidate)));
        }
        if (candidate.chain === "bsc" && bscDetector) {
          return withTokenRisk(await gatedCreatorHistory.enrich(await bscDetector.refreshHolders(candidate)));
        }
        if (candidate.chain === "base" && baseDetector) {
          return withTokenRisk(await gatedCreatorHistory.enrich(await baseDetector.refreshHolders(candidate)));
        }
        if (candidate.chain === "robinhood" && robinhoodDetector) {
          return withTokenRisk(await gatedCreatorHistory.enrich(await robinhoodDetector.refreshHolders(candidate)));
        }
        return candidate;
      },
    },
    candidateView,
  });
  registerCandidatePipeline({
    eventBus,
    repository,
    notifier,
    logger,
    maxCandidateAgeMs: config.maxCandidateAgeMs,
    availabilityChecker: {
      async isAvailable(candidate) {
        if (candidate.chain === "solana" && pumpDetector) return pumpDetector.isTokenAvailable(candidate);
        if (candidate.chain === "bsc" && bscDetector) return bscDetector.isTokenAvailable(candidate);
        if (candidate.chain === "base" && baseDetector) return baseDetector.isTokenAvailable(candidate);
        if (candidate.chain === "robinhood") return robinhoodDetector.isTokenAvailable(candidate);
        return undefined;
      },
    },
    candidateEnricher: gatedCreatorHistory,
    riskEvaluator: { evaluate: withTokenRisk },
  });

  await configureUi();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "Stopping Telegram bot");
    stopUi();
    await Promise.allSettled([
      pumpDetector?.stop(),
      bscDetector?.stop(),
      baseDetector?.stop(),
      robinhoodDetector?.stop(),
      creatorHistory.flush(),
    ]);
    await bot.stop().catch((error: unknown) => logger.error({ err: error }, "Failed to stop Telegram polling"));
    releaseProcessLock();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  try {
    if (pumpDetector) {
      await pumpDetector.start();
    } else {
      logger.warn("SOLANA_RPC_HTTP is missing; Pump.fun detection is unavailable");
    }
    await robinhoodDetector.start().catch((error: unknown) => {
      logger.error({ err: error }, "Robinhood detector failed to start; other detectors remain active");
    });
    if (bscDetector) {
      await bscDetector.start().catch((error: unknown) => {
        logger.error({ err: error }, "BSC detector failed to start; other detectors remain active");
      });
    } else {
      logger.warn("BSC_RPC_HTTP is missing; PancakeSwap detection is unavailable");
    }
    if (baseDetector) {
      await baseDetector.start().catch((error: unknown) => {
        logger.error({ err: error }, "Base detector failed to start; other detectors remain active");
      });
    } else {
      logger.warn("BASE_RPC_HTTP is missing; Base Uniswap detection is unavailable");
    }
    logger.info(
      { mode: "DISCOVERY_ONLY" },
      "Starting Telegram bot",
    );
    while (!stopping) {
      try {
        await bot.start({
          allowed_updates: ["message", "callback_query"],
          onStart: (botInfo) => logger.info({ username: botInfo.username }, "Telegram bot started"),
        });
        if (!stopping) {
          logger.warn("Telegram polling stopped unexpectedly; restarting in 5 seconds");
          await wait(5_000);
        }
      } catch (error) {
        if (error instanceof GrammyError && error.error_code === 409 && !stopping) {
          logger.warn("Another getUpdates request owns Telegram polling; detector remains active and polling will retry in 35 seconds");
          await wait(35_000);
          continue;
        }
        throw error;
      }
    }
  } finally {
    stopUi();
    await Promise.allSettled([
      pumpDetector?.stop(),
      bscDetector?.stop(),
      baseDetector?.stop(),
      robinhoodDetector?.stop(),
      creatorHistory.flush(),
    ]);
    releaseProcessLock();
  }
}

main().catch((error: unknown) => {
  // No config object exists if startup validation itself fails.
  console.error("Fatal startup error", error);
  process.exitCode = 1;
});

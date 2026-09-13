import type { Logger } from "pino";
import type { TelegramNotifier } from "../bot/bot.js";
import type { EventBus } from "../events/event-bus.js";
import type { TokenCandidate } from "../domain/token-candidate.js";
import type { CandidateRepository } from "./repository.js";

export interface CandidateAvailabilityChecker {
  /** Return undefined when the provider cannot make a definitive decision. */
  isAvailable(candidate: TokenCandidate): Promise<boolean | undefined>;
}

export interface CandidateRiskEvaluator {
  evaluate(candidate: TokenCandidate): TokenCandidate;
}

export interface CandidateEnricher {
  enrich(candidate: TokenCandidate): Promise<TokenCandidate>;
}

export function registerCandidatePipeline(dependencies: {
  eventBus: EventBus;
  repository: CandidateRepository;
  notifier: TelegramNotifier;
  logger: Logger;
  maxCandidateAgeMs?: number;
  availabilityChecker?: CandidateAvailabilityChecker;
  candidateEnricher?: CandidateEnricher;
  riskEvaluator?: CandidateRiskEvaluator;
}): () => void {
  const availability = new Map<string, boolean>();
  const isStale = (candidate: { id: string; discoveredAt: Date }) => {
    const maximumAge = dependencies.maxCandidateAgeMs ?? Number.POSITIVE_INFINITY;
    const age = Date.now() - candidate.discoveredAt.getTime();
    if (age <= maximumAge) return false;
    dependencies.logger.info({ candidateId: candidate.id, ageMs: age, maximumAgeMs: maximumAge }, "Stale candidate ignored");
    return true;
  };
  const isUnavailable = async (candidate: TokenCandidate) => {
    const cached = availability.get(candidate.id);
    if (cached !== undefined) return !cached;
    if (!dependencies.availabilityChecker) return false;
    try {
      const result = await dependencies.availabilityChecker.isAvailable(candidate);
      if (result === undefined) return false;
      availability.set(candidate.id, result);
      if (result) return false;
      dependencies.logger.info(
        { candidateId: candidate.id, chain: candidate.chain, address: candidate.address },
        "Candidate ignored because token is unavailable on-chain",
      );
      return true;
    } catch (error) {
      dependencies.logger.warn({ err: error, candidateId: candidate.id }, "Token availability check failed open");
      return false;
    }
  };
  const enrichAndEvaluate = async (candidate: TokenCandidate) => {
    const enriched = await dependencies.candidateEnricher?.enrich(candidate) ?? candidate;
    return dependencies.riskEvaluator?.evaluate(enriched) ?? enriched;
  };
  const unsubscribeLaunches = dependencies.eventBus.on("LaunchpadTokenCreated", async ({ candidate }) => {
    if (isStale(candidate) || await isUnavailable(candidate)) return;
    const evaluated = await enrichAndEvaluate(candidate);
    const result = await dependencies.repository.upsertCandidate(evaluated);
    if (!result.created) {
      dependencies.logger.debug({ candidateId: result.candidate.id }, "Duplicate candidate merged");
      return;
    }
    await dependencies.notifier.candidateDetected(result.candidate);
  });
  const unsubscribeMarketCaps = dependencies.eventBus.on("TokenMarketCapUpdated", async ({ candidate }) => {
    if (isStale(candidate) || await isUnavailable(candidate)) return;
    const evaluated = await enrichAndEvaluate(candidate);
    const result = await dependencies.repository.upsertCandidate(evaluated);
    await dependencies.notifier.candidateUpdated(result.candidate);
  });
  const unsubscribePools = dependencies.eventBus.on("PoolCreated", async ({ candidate }) => {
    if (isStale(candidate) || await isUnavailable(candidate)) return;
    const evaluated = await enrichAndEvaluate(candidate);
    const result = await dependencies.repository.upsertCandidate(evaluated);
    if (!result.created) return;
    await dependencies.notifier.candidateDetected(result.candidate);
  });
  return () => {
    unsubscribeLaunches();
    unsubscribeMarketCaps();
    unsubscribePools();
  };
}

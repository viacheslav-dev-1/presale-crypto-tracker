import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { registerCandidatePipeline } from "../src/candidates/pipeline.js";
import { createInMemoryCandidateRepository } from "../src/candidates/repository.js";
import { createEventBus } from "../src/events/event-bus.js";
import type { TokenCandidate } from "../src/domain/token-candidate.js";

const candidate: TokenCandidate = {
  id: "solana:mint",
  chain: "solana",
  source: "pumpfun",
  address: "mint",
  discoveredAt: new Date("2026-09-10T10:00:00.000Z"),
  fomoListed: false,
  tradable: true,
};

describe("candidate pipeline", () => {
  it("preserves first seen time and notifies only once", async () => {
    const eventBus = createEventBus();
    const repository = createInMemoryCandidateRepository();
    const detected = vi.fn(async () => undefined);
    registerCandidatePipeline({
      eventBus,
      repository,
      notifier: { candidateDetected: detected, candidateUpdated: vi.fn(), tradeUpdated: vi.fn() },
      logger: pino({ level: "silent" }),
    });
    await eventBus.emit({ type: "LaunchpadTokenCreated", candidate });
    await eventBus.emit({
      type: "LaunchpadTokenCreated",
      candidate: { ...candidate, discoveredAt: new Date("2026-09-10T10:01:00.000Z"), symbol: "NEW" },
    });

    expect(detected).toHaveBeenCalledTimes(1);
    await expect(repository.findByAddress("solana", "mint")).resolves.toMatchObject({
      discoveredAt: candidate.discoveredAt,
      symbol: "NEW",
    });
  });

  it("does not notify candidates older than the configured freshness window", async () => {
    const eventBus = createEventBus();
    const detected = vi.fn(async () => undefined);
    registerCandidatePipeline({
      eventBus,
      repository: createInMemoryCandidateRepository(),
      notifier: { candidateDetected: detected, candidateUpdated: vi.fn(), tradeUpdated: vi.fn() },
      logger: pino({ level: "silent" }),
      maxCandidateAgeMs: 10 * 60_000,
    });
    await eventBus.emit({
      type: "LaunchpadTokenCreated",
      candidate: { ...candidate, discoveredAt: new Date(Date.now() - 11 * 60_000) },
    });
    expect(detected).not.toHaveBeenCalled();
  });

  it("filters definitively unavailable tokens but keeps indeterminate RPC results", async () => {
    const eventBus = createEventBus();
    const detected = vi.fn(async () => undefined);
    const availability = vi.fn(async (item: TokenCandidate) => item.id === "solana:missing" ? false : undefined);
    registerCandidatePipeline({
      eventBus,
      repository: createInMemoryCandidateRepository(),
      notifier: { candidateDetected: detected, candidateUpdated: vi.fn(), tradeUpdated: vi.fn() },
      logger: pino({ level: "silent" }),
      availabilityChecker: { isAvailable: availability },
    });

    await eventBus.emit({ type: "LaunchpadTokenCreated", candidate: { ...candidate, id: "solana:missing" } });
    await eventBus.emit({ type: "LaunchpadTokenCreated", candidate: { ...candidate, id: "solana:uncertain" } });

    expect(detected).toHaveBeenCalledOnce();
    expect(detected).toHaveBeenCalledWith(expect.objectContaining({ id: "solana:uncertain" }));
  });

  it("enriches a candidate before evaluating risk and notifying", async () => {
    const eventBus = createEventBus();
    const detected = vi.fn(async () => undefined);
    const enrich = vi.fn(async (item: TokenCandidate) => ({ ...item, creator: "Creator" }));
    const evaluate = vi.fn((item: TokenCandidate) => ({ ...item, riskScore: item.creator ? 10 : 99 }));
    registerCandidatePipeline({
      eventBus,
      repository: createInMemoryCandidateRepository(),
      notifier: { candidateDetected: detected, candidateUpdated: vi.fn(), tradeUpdated: vi.fn() },
      logger: pino({ level: "silent" }),
      candidateEnricher: { enrich },
      riskEvaluator: { evaluate },
    });

    await eventBus.emit({ type: "LaunchpadTokenCreated", candidate });
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ creator: "Creator" }));
    expect(detected).toHaveBeenCalledWith(expect.objectContaining({ creator: "Creator", riskScore: 10 }));
  });
});

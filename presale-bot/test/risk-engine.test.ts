import { describe, expect, it } from "vitest";
import type { TokenCandidate } from "../src/domain/token-candidate.js";
import { evaluateTokenRisk, withTokenRisk } from "../src/risk/risk-engine.js";

const baseCandidate: TokenCandidate = {
  id: "solana:risk",
  chain: "solana",
  source: "pumpfun",
  address: "Mint",
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  poolAddress: "BondingCurve",
  creator: "Creator",
  discoveredAt: new Date(),
  fomoListed: false,
  tradable: true,
  marketCapUsd: 75_000,
  priceUsd: 0.000075,
  liquidityUsd: 30_000,
  holderCount: 120,
  holders: [
    { address: "BondingCurve", balance: 800_000, percentage: 80 },
    { address: "Wallet", balance: 50_000, percentage: 5 },
  ],
  metadata: { mintAccountVerified: true, mintAuthority: null, freezeAuthority: null },
};

describe("token risk engine", () => {
  it("does not treat known pool inventory as external holder concentration", () => {
    const result = evaluateTokenRisk(baseCandidate);
    expect(result.score).toBeLessThanOrEqual(20);
    expect(result.assessment.level).toBe("LOWER");
    expect(result.assessment.factors).toContain("✓ mint authority is revoked");
    expect(result.assessment.factors.join(" ")).not.toContain("80.00%");
    expect(result.assessment.missingChecks).toContain("buy and sell simulation");
  });

  it("assigns extreme observed risk for concentrated, controllable micro-cap tokens", () => {
    const result = evaluateTokenRisk({
      ...baseCandidate,
      tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      marketCapUsd: 5_000,
      liquidityUsd: 1_000,
      holderCount: 5,
      holders: [{ address: "Creator", balance: 600_000, percentage: 60 }],
      metadata: { mintAccountVerified: true, mintAuthority: "MintAdmin", freezeAuthority: "FreezeAdmin" },
    });
    expect(result.score).toBe(100);
    expect(result.assessment.level).toBe("EXTREME");
    expect(result.assessment.factors).toEqual(expect.arrayContaining([
      "+35: largest known external wallet holds 60.00%",
      "+25: mint authority can create more supply",
      "+30: freeze authority can freeze holder accounts",
    ]));
  });

  it("marks sparse observations as insufficient data rather than a confident result", () => {
    const candidate = withTokenRisk({
      id: "solana:unknown",
      chain: "solana",
      source: "pumpfun",
      address: "Unknown",
      discoveredAt: new Date(),
      fomoListed: false,
    });
    expect(candidate.riskAssessment?.status).toBe("INSUFFICIENT_DATA");
    expect(candidate.riskAssessment?.confidence).toBe("LOW");
    expect(candidate.riskAssessment?.missingChecks.length).toBeGreaterThanOrEqual(4);
  });

  it("uses severe outcomes from observed creator history as risk evidence", () => {
    const result = evaluateTokenRisk({
      ...baseCandidate,
      creatorHistory: {
        creator: "Creator",
        coverageStartedAt: new Date().toISOString(),
        observedLaunches: 2,
        previousObservedLaunches: 1,
        previousTokens: [],
        meaningfulLiquidityUsd: 25_000,
        reachedMeaningfulLiquidity: 1,
        lostNinetyPercent: 1,
        severeLiquidityDrops: 1,
        warnings: [],
      },
    });
    expect(result.assessment.factors).toEqual(expect.arrayContaining([
      "+20: creator has 1 token(s) with an observed liquidity drop of at least 90%",
      "+15: creator has 1 token(s) down at least 90% from an observed market-cap peak",
    ]));
  });
});

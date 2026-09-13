import type { RiskAssessment, RiskLevel, TokenCandidate, TokenHolder } from "../domain/token-candidate.js";

const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export interface RiskEvaluation {
  score: number;
  assessment: RiskAssessment;
}

function riskLevel(score: number): RiskLevel {
  if (score <= 20) return "LOWER";
  if (score <= 40) return "MODERATE";
  if (score <= 60) return "ELEVATED";
  if (score <= 80) return "HIGH";
  return "EXTREME";
}

function externalHolders(candidate: TokenCandidate): readonly TokenHolder[] {
  const excluded = new Set(
    [candidate.poolAddress, candidate.metadata?.associatedBondingCurve]
      .filter((address): address is string => typeof address === "string")
      .map((address) => address.toLowerCase()),
  );
  return (candidate.holders ?? []).filter((holder) => !excluded.has(holder.address.toLowerCase()));
}

export function evaluateTokenRisk(candidate: TokenCandidate): RiskEvaluation {
  let score = 0;
  const factors: string[] = [];
  const missingChecks: string[] = [];
  const addRisk = (points: number, factor: string) => {
    score += points;
    factors.push(`+${points}: ${factor}`);
  };
  const addPositive = (factor: string) => factors.push(`✓ ${factor}`);
  const addMissing = (check: string) => {
    if (!missingChecks.includes(check)) missingChecks.push(check);
  };

  if (candidate.tradable === false) addRisk(30, "usable trading liquidity is not confirmed");
  else if (candidate.tradable === true) addPositive("token is marked tradeable by its detected venue");
  else addMissing("tradeability confirmation");

  if (candidate.marketCapUsd === undefined) addMissing("market capitalization");
  else if (candidate.marketCapUsd < 10_000) addRisk(15, "micro-cap below $10,000 has extreme volatility");
  else if (candidate.marketCapUsd < 50_000) addRisk(8, "market cap is below $50,000");
  else addPositive("market cap is at least $50,000");

  if (candidate.priceUsd === undefined) addMissing("USD price");
  if (candidate.liquidityUsd === undefined) {
    addMissing("USD liquidity and slippage");
  } else {
    if (candidate.liquidityUsd < 5_000) addRisk(30, "liquidity is below $5,000");
    else if (candidate.liquidityUsd < 25_000) addRisk(15, "liquidity is below $25,000");
    else addPositive("liquidity is at least $25,000");
    if (candidate.marketCapUsd && candidate.liquidityUsd / candidate.marketCapUsd < 0.05) {
      addRisk(20, "liquidity is below 5% of market cap");
    }
  }

  const holders = externalHolders(candidate);
  if (candidate.holderCount === undefined || candidate.holders === undefined) {
    addMissing("holder count and concentration");
  } else {
    if (candidate.holderCount < 10) addRisk(20, "fewer than 10 non-zero holder wallets");
    else if (candidate.holderCount < 50) addRisk(12, "fewer than 50 non-zero holder wallets");
    else if (candidate.holderCount < 100) addRisk(6, "fewer than 100 non-zero holder wallets");
    const largest = holders.reduce((maximum, holder) => Math.max(maximum, holder.percentage ?? 0), 0);
    if (largest >= 50) addRisk(35, `largest known external wallet holds ${largest.toFixed(2)}%`);
    else if (largest >= 25) addRisk(20, `largest known external wallet holds ${largest.toFixed(2)}%`);
    else if (largest >= 10) addRisk(8, `largest known external wallet holds ${largest.toFixed(2)}%`);
    else if (holders.length > 0 && holders.every((holder) => holder.percentage !== undefined)) {
      addPositive("no known external top holder owns 10% or more");
    } else {
      addMissing("external-holder ownership percentages");
    }
    const creator = candidate.creator?.toLowerCase();
    const creatorHolder = creator ? holders.find((holder) => holder.address.toLowerCase() === creator) : undefined;
    if (creatorHolder?.percentage !== undefined && creatorHolder.percentage >= 10) {
      addRisk(25, `creator wallet holds ${creatorHolder.percentage.toFixed(2)}%`);
    } else if (!creator) {
      addMissing("creator holdings");
    }
  }

  if (candidate.chain === "solana") {
    const verified = candidate.metadata?.mintAccountVerified;
    const mintAuthority = candidate.metadata?.mintAuthority;
    const freezeAuthority = candidate.metadata?.freezeAuthority;
    if (verified === false) addRisk(100, "mint account failed on-chain validation");
    else if (verified !== true) addMissing("mint account and authority validation");
    if (verified === true) {
      if (typeof mintAuthority === "string") addRisk(25, "mint authority can create more supply");
      else if (mintAuthority === null) addPositive("mint authority is revoked");
      else addMissing("mint authority");
      if (typeof freezeAuthority === "string") addRisk(30, "freeze authority can freeze holder accounts");
      else if (freezeAuthority === null) addPositive("freeze authority is revoked");
      else addMissing("freeze authority");
    }
    if (candidate.tokenProgram === TOKEN_2022_PROGRAM_ID) {
      addRisk(10, "Token-2022 mint may contain advanced transfer controls");
      addMissing("Token-2022 extension inspection");
    }
    addMissing("buy and sell simulation");
  } else {
    addMissing("buy/sell simulation and transfer taxes");
    addMissing("owner, proxy, blacklist, pause, and mint permissions");
  }


  if (candidate.creatorHistory) {
    if (candidate.creatorHistory.severeLiquidityDrops > 0) {
      addRisk(20, `creator has ${candidate.creatorHistory.severeLiquidityDrops} token(s) with an observed liquidity drop of at least 90%`);
    }
    if (candidate.creatorHistory.lostNinetyPercent > 0) {
      addRisk(15, `creator has ${candidate.creatorHistory.lostNinetyPercent} token(s) down at least 90% from an observed market-cap peak`);
    }
    if (candidate.creatorHistory.previousObservedLaunches >= 3 && candidate.creatorHistory.reachedMeaningfulLiquidity === 0) {
      addRisk(10, "none of the creator's observed launches reached the meaningful-liquidity threshold");
    }
  }

  score = Math.min(100, Math.max(0, Math.round(score)));
  const confidence = missingChecks.length <= 1 ? "HIGH" : missingChecks.length <= 3 ? "MEDIUM" : "LOW";
  const lacksTradeSimulation = missingChecks.some((check) => check.includes("simulation"));
  return {
    score,
    assessment: {
      status: missingChecks.length >= 4 || lacksTradeSimulation ? "INSUFFICIENT_DATA" : "ASSESSED",
      level: riskLevel(score),
      confidence,
      factors,
      missingChecks,
    },
  };
}

export function withTokenRisk(candidate: TokenCandidate): TokenCandidate {
  const { score, assessment } = evaluateTokenRisk(candidate);
  return { ...candidate, riskScore: score, riskAssessment: assessment };
}

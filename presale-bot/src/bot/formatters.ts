import type { BotSnapshot } from "./state.js";
import type { Chain, TokenCandidate } from "../domain/token-candidate.js";
import { fomoTokenUrl, tokenExplorerUrl } from "./links.js";

const CHAIN_LABELS: Record<Chain, string> = {
  solana: "Solana",
  bsc: "BSC",
  base: "Base",
  robinhood: "Robinhood Chain",
};

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatCandidateLinks(candidate: TokenCandidate): string {
  return `[<a href="${escapeHtml(fomoTokenUrl(candidate))}">FOMO</a>] [<a href="${escapeHtml(tokenExplorerUrl(candidate))}">EXPLORER</a>]`;
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} sec`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`;
}

function formatLongDuration(milliseconds: number): string {
  const days = Math.max(0, Math.floor(milliseconds / 86_400_000));
  if (days >= 365) return `${Math.floor(days / 365)}y ${Math.floor(days % 365 / 30)}mo`;
  if (days >= 30) return `${Math.floor(days / 30)}mo ${days % 30}d`;
  if (days >= 1) return `${days}d ${Math.floor(milliseconds % 86_400_000 / 3_600_000)}h`;
  return formatDuration(milliseconds);
}

export function formatStatus(snapshot: BotSnapshot, enabledChains: readonly Chain[]): string {
  const enabled = enabledChains.map((chain) => CHAIN_LABELS[chain]).join(", ") || "None";
  return [
    "<b>Bot status</b>",
    "",
    "Runtime: ✅ Running",
    `Mode: <code>${snapshot.mode}</code>`,
    `Chains: ${enabled}`,
    `Detections: ${snapshot.detections}`,
    `Uptime: ${formatDuration(Date.now() - snapshot.startedAt.getTime())}`,
  ].join("\n");
}

export function formatCandidate(
  candidate: TokenCandidate,
  now = new Date(),
  options: { showHolders?: boolean; showCreatorHistory?: boolean } = {},
): string {
  const token = escapeHtml(candidate.symbol ?? candidate.name ?? "Unknown");
  const address = escapeHtml(candidate.address);
  const lines = [
    `🚨 <b>${token}</b>`,
    "",
    `Chain: ${CHAIN_LABELS[candidate.chain]}`,
    `Source: ${escapeHtml(candidate.source)}`,
    "",
    `${candidate.chain === "solana" ? "Mint / Token Address" : "Token / Smart Contract Address"}: <code>${address}</code>`,
  ];

  if (candidate.chain === "solana" && candidate.tokenProgram) {
    lines.push(`Token Program (shared smart contract): <code>${escapeHtml(candidate.tokenProgram)}</code>`);
  }
  if (candidate.chain !== "solana" && candidate.metadata?.factoryType !== "v4" && typeof candidate.metadata?.factory === "string") {
    lines.push(`DEX Factory (smart contract): <code>${escapeHtml(candidate.metadata.factory)}</code>`);
  }
  if (candidate.chain !== "solana" && typeof candidate.metadata?.factoryName === "string") {
    lines.push(`Factory: ${escapeHtml(candidate.metadata.factoryName)}`);
  }
  if (candidate.metadata?.factoryType === "v4" && candidate.poolAddress) {
    lines.push(`Pool Manager (smart contract): <code>${escapeHtml(candidate.poolAddress)}</code>`);
    if (typeof candidate.metadata.poolId === "string") {
      lines.push(`Pool ID: <code>${escapeHtml(candidate.metadata.poolId)}</code>`);
    }
  } else if (candidate.poolAddress) {
    lines.push(`Pool: <code>${escapeHtml(candidate.poolAddress)}</code>`);
  }
  if (candidate.creator && options.showCreatorHistory !== false) {
    lines.push(`Creator: <code>${escapeHtml(candidate.creator)}</code>`);
  }
  if (candidate.liquidityUsd !== undefined) {
    const liquidityLabel = candidate.liquidityAnalysis?.venueType === "BONDING_CURVE"
      ? "Effective virtual liquidity"
      : "Liquidity";
    lines.push(`${liquidityLabel}: ~$${candidate.liquidityUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
  }
  lines.push(candidate.marketCapUsd === undefined
    ? "Market cap: Unavailable"
    : `Market cap: ~$${candidate.marketCapUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
  lines.push(candidate.priceUsd === undefined
    ? "Token price: Unavailable"
    : `Token price: $${formatUsdTokenPrice(candidate.priceUsd)}`);
  lines.push(formatCandidateLinks(candidate));

  if (candidate.liquidityAnalysis) {
    const analysis = candidate.liquidityAnalysis;
    const venue = analysis.venueType === "BONDING_CURVE"
      ? "Pump.fun virtual bonding curve"
      : analysis.venueType === "V2_AMM"
        ? "Constant-product V2 pool"
        : "Concentrated-liquidity V3/V4 pool";
    const liquidityDetails = ["<b>Liquidity details</b>", `Venue: ${venue}`];
    if (analysis.tokenReserve !== undefined) {
      liquidityDetails.push(`Token reserve: ${analysis.tokenReserve.toLocaleString("en-US", { maximumFractionDigits: 6 })}`);
    }
    if (analysis.quoteReserve !== undefined) {
      liquidityDetails.push(
        `Quote reserve: ${analysis.quoteReserve.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${escapeHtml(analysis.quoteSymbol ?? "quote token")}`,
      );
    }
    if (analysis.liquidityToMarketCapPercent !== undefined) {
      liquidityDetails.push(`Liquidity / market cap: ${analysis.liquidityToMarketCapPercent.toFixed(2)}%`);
    }
    if (analysis.priceImpactEstimates?.length) {
      liquidityDetails.push("<b>Estimated buy price impact</b>");
      analysis.priceImpactEstimates.forEach((estimate) => {
        liquidityDetails.push(`• $${estimate.tradeUsd.toLocaleString("en-US")}: ${estimate.impactPercent.toFixed(2)}%`);
      });
    } else {
      liquidityDetails.push("Estimated buy price impact: Unavailable");
    }
    liquidityDetails.push(
      `Liquidity control: <b>${analysis.controlStatus === "PROGRAM_CONTROLLED" ? "PROGRAM CONTROLLED" : "UNVERIFIED"}</b>`,
      escapeHtml(analysis.controlDescription),
    );
    analysis.warnings.forEach((warning) => liquidityDetails.push(`⚠️ ${escapeHtml(warning)}`));
    lines.push("", `<blockquote expandable>${liquidityDetails.join("\n")}</blockquote>`);
  }

  if (candidate.creatorHistory && options.showCreatorHistory !== false) {
    const history = candidate.creatorHistory;
    const details = [
      "<b>Creator history · observed by this bot</b>",
      `Previous launches observed: ${history.previousObservedLaunches.toLocaleString("en-US")}`,
      `Reached ≥$${history.meaningfulLiquidityUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })} liquidity: ${history.reachedMeaningfulLiquidity.toLocaleString("en-US")} / ${history.observedLaunches.toLocaleString("en-US")}`,
      `Lost ≥90% from observed market-cap peak: ${history.lostNinetyPercent.toLocaleString("en-US")}`,
      `Severe observed liquidity drops (≥90%): ${history.severeLiquidityDrops.toLocaleString("en-US")}`,
    ];
    if (history.previousTokens.length > 0) {
      details.push("<b>Recent previous launches</b>");
      history.previousTokens.forEach((token) => {
        const outcome = [
          token.reachedMeaningfulLiquidity ? "reached liquidity" : undefined,
          token.lostNinetyPercent ? "down ≥90%" : undefined,
          token.severeLiquidityDrop ? "liquidity down ≥90%" : undefined,
        ].filter((value): value is string => value !== undefined).join(", ") || "no recorded outcome yet";
        details.push(`• ${escapeHtml(token.symbol ?? "Unknown")} · <code>${escapeHtml(token.address)}</code> — ${outcome}`);
      });
    }
    if (history.averageObservedDurationMs !== undefined) {
      details.push(`Average observed tracking duration: ${formatLongDuration(history.averageObservedDurationMs)}`);
    }
    details.push(history.currentHoldingPercent === undefined
      ? "Current creator holding: Unavailable"
      : `Current creator holding: ${history.currentHoldingPercent.toFixed(2)}%`);
    details.push(history.firstObservedSaleAt
      ? `First observed creator sale: ${escapeHtml(new Date(history.firstObservedSaleAt).toISOString())}`
      : "First creator sale: Not observed during local coverage");
    if (history.funding) {
      const fundingLabel = history.funding.label ? `${escapeHtml(history.funding.label)} — ` : "";
      details.push(`Funded by: ${fundingLabel}<code>${escapeHtml(history.funding.address)}</code>`);
      if (history.funding.amount !== undefined) {
        details.push(`Initial funding: ${history.funding.amount.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${escapeHtml(history.funding.symbol ?? "")}`.trim());
      }
      if (history.funding.fundedAt) {
        const fundedAt = new Date(history.funding.fundedAt);
        if (Number.isFinite(fundedAt.getTime())) details.push(`Wallet funding age: ${formatLongDuration(now.getTime() - fundedAt.getTime())}`);
      }
    } else if (candidate.chain === "solana") {
      details.push("Funding source / wallet age: Unavailable");
    }
    details.push(`Coverage since: ${escapeHtml(history.coverageStartedAt)}`);
    history.warnings.forEach((warning) => details.push(`⚠️ ${escapeHtml(warning)}`));
    lines.push(
      "",
      `Creator launches observed: ${history.observedLaunches.toLocaleString("en-US")}`,
      `<blockquote expandable>${details.join("\n")}</blockquote>`,
    );
  }

  if (options.showHolders !== false) {
    lines.push(
      "",
      `Total holders: ${candidate.holderCount === undefined ? "Unavailable" : candidate.holderCount.toLocaleString("en-US")}`,
      "<b>Top 5 holders</b>",
    );
    if (!candidate.holders?.length) {
      lines.push("Unavailable");
    } else {
      candidate.holders.forEach((holder, index) => {
        const balance = holder.balance.toLocaleString("en-US", { maximumFractionDigits: 6 });
        const share = holder.percentage === undefined ? "" : ` (${holder.percentage.toFixed(2)}%)`;
        const value = holder.valueUsd === undefined
          ? ""
          : ` · ~$${holder.valueUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
        const label = holder.label ? `${escapeHtml(holder.label)} — ` : "";
        lines.push(`#${index + 1} ${label}<code>${escapeHtml(holder.address)}</code>: ${balance}${share}${value}`);
      });
    }
  }

  lines.push(
    "",
    `Detected: ${formatDuration(now.getTime() - candidate.discoveredAt.getTime())} ago`,
  );
  if (candidate.riskScore === undefined || !candidate.riskAssessment) {
    lines.push(`Risk: ⚪ ${candidate.riskScore === undefined ? "Pending" : `${candidate.riskScore}/100`}`);
  } else {
    lines.push(
      `Risk: ${lightRiskEmoji(candidate)} <b>${candidate.riskScore}/100 · ${escapeHtml(candidate.riskAssessment.level)}</b>`,
      `Risk assessment: <b>${candidate.riskAssessment.status === "INSUFFICIENT_DATA" ? "INSUFFICIENT DATA" : "ASSESSED"}</b>`,
      `Risk confidence: <b>${escapeHtml(candidate.riskAssessment.confidence)}</b>`,
    );
    const riskDetails: string[] = [];
    if (candidate.riskAssessment.factors.length > 0) {
      riskDetails.push("<b>Risk evidence</b>");
      candidate.riskAssessment.factors.slice(0, 8).forEach((factor) => riskDetails.push(`• ${escapeHtml(factor)}`));
    }
    if (candidate.riskAssessment.missingChecks.length > 0) {
      riskDetails.push("<b>Not yet verified</b>");
      candidate.riskAssessment.missingChecks.slice(0, 6).forEach((check) => riskDetails.push(`• ${escapeHtml(check)}`));
    }
    riskDetails.push("<i>Heuristic risk estimate—not a guarantee or buy recommendation.</i>");
    lines.push(`<blockquote expandable>${riskDetails.join("\n")}</blockquote>`);
  }

  return lines.join("\n");
}

export function formatUsdTokenPrice(price: number): string {
  if (price >= 1) return price.toLocaleString("en-US", { maximumFractionDigits: 8 });
  if (price >= 0.000001) return price.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return price.toExponential(6);
}

export function formatCompactUsdTokenPrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return formatUsdTokenPrice(price);
  const exponent = Math.floor(Math.log10(price));
  const leadingFractionZeros = exponent < 0 ? Math.abs(exponent) - 1 : 0;
  if (leadingFractionZeros <= 2) return formatUsdTokenPrice(price);
  const [mantissa = "0"] = price.toExponential(7).split("e");
  const significantDigits = mantissa.replace(".", "").replace(/0+$/, "");
  return `0.0(${leadingFractionZeros - 1})${significantDigits}`;
}

function lightRiskEmoji(candidate: TokenCandidate): string {
  switch (candidate.riskAssessment?.level) {
    case "LOWER": return "🟢";
    case "MODERATE": return "🟡";
    case "ELEVATED":
    case "HIGH":
    case "EXTREME": return "🔴";
    default: return "⚪";
  }
}

function lightFactoryName(candidate: TokenCandidate): string | undefined {
  if (typeof candidate.metadata?.factoryName !== "string") return undefined;
  return candidate.metadata.factoryName.replace(/\s+(?:Pool|Pull)Manager\b/gi, "").trim();
}

export function formatLightCandidate(candidate: TokenCandidate): string {
  const token = escapeHtml(candidate.symbol ?? candidate.name ?? "Unknown");
  const context = [
    candidate.chain === "robinhood" ? "Robinhood" : CHAIN_LABELS[candidate.chain],
    candidate.source ? escapeHtml(candidate.source) : undefined,
    lightFactoryName(candidate) ? escapeHtml(lightFactoryName(candidate) ?? "") : undefined,
  ].filter((value): value is string => value !== undefined);
  const price = candidate.priceUsd === undefined ? "Unavailable" : `$${formatCompactUsdTokenPrice(candidate.priceUsd)}`;
  const cap = candidate.marketCapUsd === undefined
    ? "Unavailable"
    : `$${candidate.marketCapUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const links = formatCandidateLinks(candidate);
  return [
    `${lightRiskEmoji(candidate)} <b>${token}</b> ${links}`,
    `🔗 ${context.join(" | ")}`,
    `🤑 P: ${price} | C: ${cap}`,
    `<code>${escapeHtml(candidate.address)}</code>`,
  ].join("\n\n");
}

export interface CandidateDigestPage {
  text: string;
  candidates: readonly TokenCandidate[];
}

export function formatCandidateDigestPages(
  candidates: readonly TokenCandidate[],
  now = new Date(),
  intervalMinutes = 1,
  options: { showHolders?: boolean; showCreatorHistory?: boolean; messageFormat?: "FULL" | "LIGHT" } = {},
): readonly CandidateDigestPage[] {
  // Light pages are capped at 20 candidates so their token-specific inline
  // keyboard remains safely below Telegram's 100-button limit.
  const maximumBodyLength = 3_800;
  const maximumCandidates = options.messageFormat === "LIGHT" ? 20 : Number.POSITIVE_INFINITY;
  const pages: Array<{ body: string; candidates: TokenCandidate[] }> = [];
  let body = "";
  let pageCandidates: TokenCandidate[] = [];

  for (const candidate of candidates) {
    const formattedEntry = options.messageFormat === "LIGHT"
      ? formatLightCandidate(candidate)
      : formatCandidate(candidate, now, options);
    const links = formatCandidateLinks(candidate);
    // Digest messages must keep permanent navigation links in their text even
    // if an individual message formatter is changed later.
    const entry = formattedEntry.includes(links) ? formattedEntry : `${formattedEntry}\n\n${links}`;
    const combined = body ? `${body}\n\n${entry}` : entry;
    if (body && (combined.length > maximumBodyLength || pageCandidates.length >= maximumCandidates)) {
      pages.push({ body, candidates: pageCandidates });
      body = entry;
      pageCandidates = [candidate];
    } else {
      body = combined;
      pageCandidates.push(candidate);
    }
  }
  if (body || candidates.length === 0) pages.push({ body, candidates: pageCandidates });

  return pages.map((pageData, index) => {
    const page = pages.length > 1 ? ` (${index + 1}/${pages.length})` : "";
    const header = [
      `🚨 <b>${intervalMinutes}-MINUTE TOKEN DIGEST${page}</b>`,
      `${candidates.length} new token${candidates.length === 1 ? "" : "s"} total`,
    ].join("\n");
    return {
      text: pageData.body ? `${header}\n\n${pageData.body}` : header,
      candidates: pageData.candidates,
    };
  });
}

export function formatCandidateDigestMessages(
  candidates: readonly TokenCandidate[],
  now = new Date(),
  intervalMinutes = 1,
  options: { showHolders?: boolean; showCreatorHistory?: boolean; messageFormat?: "FULL" | "LIGHT" } = {},
): readonly string[] {
  return formatCandidateDigestPages(candidates, now, intervalMinutes, options).map((page) => page.text);
}

export function formatCandidateDigest(candidates: readonly TokenCandidate[], now = new Date(), intervalMinutes = 1): string {
  return formatCandidateDigestMessages(candidates, now, intervalMinutes)[0] ?? "";
}

export function chainLabel(chain: Chain): string {
  return CHAIN_LABELS[chain];
}

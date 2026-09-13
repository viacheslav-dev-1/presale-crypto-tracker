import type { TokenCandidate } from "../../../domain/token-candidate.js";
import type { PumpCreation } from "./decoder.js";

export function normalizePumpCreation(
  creation: PumpCreation,
  observation: { signature: string; slot: number; observedAt: Date; chainTimestamp?: Date },
): TokenCandidate {
  const onChainTimestamp = creation.onChainTimestamp ?? observation.chainTimestamp;
  const discoveredAt = onChainTimestamp &&
    onChainTimestamp.getTime() > 0 &&
    onChainTimestamp.getTime() <= observation.observedAt.getTime() + 60_000
    ? onChainTimestamp
    : observation.observedAt;
  const tradeable =
    creation.realTokenReserves === undefined ||
    (creation.realTokenReserves > 0n && (creation.virtualQuoteReserves ?? 0n) > 0n);

  return {
    id: `solana:${creation.mint}`,
    chain: "solana",
    source: "pumpfun",
    address: creation.mint,
    name: creation.name,
    symbol: creation.symbol,
    decimals: 6,
    creator: creation.creator,
    ...(creation.tokenProgram ? { tokenProgram: creation.tokenProgram } : {}),
    poolAddress: creation.bondingCurve,
    ...(creation.quoteMint ? { quoteToken: creation.quoteMint } : {}),
    slot: observation.slot,
    signature: observation.signature,
    discoveredAt,
    ...(tradeable ? { tradeableAt: discoveredAt } : {}),
    fomoListed: false,
    tradable: tradeable,
    metadata: {
      uri: creation.uri,
      user: creation.user,
      associatedBondingCurve: creation.associatedBondingCurve,
      tokenProgram: creation.tokenProgram,
      instructionVariant: creation.variant,
      onChainTimestamp: creation.onChainTimestamp?.toISOString(),
      receivedAt: observation.observedAt.toISOString(),
      virtualTokenReserves: creation.virtualTokenReserves?.toString(),
      virtualQuoteReserves: creation.virtualQuoteReserves?.toString(),
      realTokenReserves: creation.realTokenReserves?.toString(),
      tokenTotalSupply: creation.tokenTotalSupply?.toString(),
      isMayhemMode: creation.isMayhemMode,
      isCashbackEnabled: creation.isCashbackEnabled,
    },
  };
}

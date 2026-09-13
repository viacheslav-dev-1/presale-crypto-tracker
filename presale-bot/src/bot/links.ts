import type { Chain, TokenCandidate } from "../domain/token-candidate.js";

const FOMO_CHAIN_PATH: Record<Chain, string> = {
  solana: "solana",
  bsc: "bnb",
  base: "base",
  robinhood: "robinhood",
};

export function fomoTokenUrl(candidate: Pick<TokenCandidate, "chain" | "address">): string {
  return `https://fomo.family/tokens/${FOMO_CHAIN_PATH[candidate.chain]}/${encodeURIComponent(candidate.address)}`;
}

export function tokenExplorerUrl(candidate: Pick<TokenCandidate, "chain" | "address">): string {
  const address = encodeURIComponent(candidate.address);
  switch (candidate.chain) {
    case "solana": return `https://solscan.io/account/${address}`;
    case "bsc": return `https://bscscan.com/address/${address}`;
    case "base": return `https://basescan.org/address/${address}`;
    case "robinhood": return `https://robinhoodchain.blockscout.com/address/${address}`;
  }
}

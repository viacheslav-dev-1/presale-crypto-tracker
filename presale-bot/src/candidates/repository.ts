import type { TokenCandidate } from "../domain/token-candidate.js";

export interface UpsertCandidateResult {
  candidate: TokenCandidate;
  created: boolean;
}

export interface CandidateRepository {
  upsertCandidate(candidate: TokenCandidate): Promise<UpsertCandidateResult>;
  findByAddress(chain: TokenCandidate["chain"], address: string): Promise<TokenCandidate | undefined>;
}

export function createInMemoryCandidateRepository(): CandidateRepository {
  const candidates = new Map<string, TokenCandidate>();
  const key = (chain: TokenCandidate["chain"], address: string) => `${chain}:${address}`;
  return {
    async upsertCandidate(candidate) {
      const candidateKey = key(candidate.chain, candidate.address);
      const existing = candidates.get(candidateKey);
      if (!existing) {
        candidates.set(candidateKey, candidate);
        return { candidate, created: true };
      }
      const merged: TokenCandidate = {
        ...existing,
        ...candidate,
        id: existing.id,
        discoveredAt: existing.discoveredAt,
        metadata: { ...existing.metadata, ...candidate.metadata },
      };
      candidates.set(candidateKey, merged);
      return { candidate: merged, created: false };
    },
    async findByAddress(chain, address) {
      return candidates.get(key(chain, address));
    },
  };
}

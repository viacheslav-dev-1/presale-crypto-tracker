import type { TokenCandidate } from "../domain/token-candidate.js";

export type BotEvent =
  | { type: "LaunchpadTokenCreated"; candidate: TokenCandidate }
  | { type: "TokenTradeable"; candidate: TokenCandidate }
  | { type: "PoolCreated"; candidate: TokenCandidate }
  | { type: "TokenMarketCapUpdated"; candidate: TokenCandidate };

export type BotEventOfType<T extends BotEvent["type"]> = Extract<BotEvent, { type: T }>;

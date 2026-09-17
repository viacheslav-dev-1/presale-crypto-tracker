import { CHAINS, type Chain, type TokenCandidate } from "../domain/token-candidate.js";
import { candidateCallbackId } from "./keyboards.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type HealthStatus = "up" | "down" | "not_configured";

export interface HealthReport {
  status: "ok" | "degraded";
  checks: Readonly<Record<string, HealthStatus>>;
}

export interface HealthService {
  check(): Promise<HealthReport>;
}

export interface CandidateStore {
  put(candidate: TokenCandidate): void;
  get(id: string): TokenCandidate | undefined;
  ignore(id: string): boolean;
}

export interface TelegramAudience {
  subscribe(chatId: number): void;
  unsubscribe(chatId: number): void;
  isSubscribed(chatId: number): boolean;
  deliveryMode(chatId: number): DeliveryMode;
  setDeliveryMode(chatId: number, mode: DeliveryMode): void;
  digestIntervalMinutes(chatId: number): DigestIntervalMinutes;
  setDigestIntervalMinutes(chatId: number, minutes: DigestIntervalMinutes): void;
  minimumMarketCapUsd(chatId: number): number;
  setMinimumMarketCapUsd(chatId: number, value: number): void;
  maximumMarketCapUsd(chatId: number): number;
  setMaximumMarketCapUsd(chatId: number, value: number): void;
  trackTokensWithoutMarketCap(chatId: number): boolean;
  setTrackTokensWithoutMarketCap(chatId: number, enabled: boolean): void;
  showHolders(chatId: number): boolean;
  setShowHolders(chatId: number, enabled: boolean): void;
  showCreatorHistory(chatId: number): boolean;
  setShowCreatorHistory(chatId: number, enabled: boolean): void;
  messageFormat(chatId: number): MessageFormat;
  setMessageFormat(chatId: number, format: MessageFormat): void;
  enabledChains(chatId: number): readonly Chain[];
  setChainEnabled(chatId: number, chain: Chain, enabled: boolean): void;
  wasCandidateDelivered(chatId: number, candidateId: string): boolean;
  markCandidateDelivered(chatId: number, candidateId: string): void;
  clearCandidateDeliveryHistory(chatId: number): void;
  deliveredCandidateIds(chatId: number): readonly string[];
  tokenUnlockTracking(chatId: number): boolean;
  setTokenUnlockTracking(chatId: number, enabled: boolean): void;
  tokenUnlockTrackingChatIds(): readonly number[];
  lastTokenUnlockNotificationDate(chatId: number): string | undefined;
  markTokenUnlockNotificationSent(chatId: number, date: string): void;
  chatIds(): readonly number[];
  allChatIds(): readonly number[];
}

export type DeliveryMode = "IMMEDIATE" | "ONE_MINUTE_DIGEST";
export type MessageFormat = "FULL" | "LIGHT";
export const DIGEST_INTERVAL_MINUTES = [1, 2, 5, 10] as const;
export type DigestIntervalMinutes = (typeof DIGEST_INTERVAL_MINUTES)[number];

export function createTelegramAudience(
  initialChatIds: Iterable<number> = [],
  defaultDeliveryMode: DeliveryMode = "ONE_MINUTE_DIGEST",
  defaultMinimumMarketCapUsd = 0,
  defaultMaximumMarketCapUsd = 10_000,
  defaultEnabledChains: readonly Chain[] = ["robinhood"],
): TelegramAudience {
  const subscribers = new Set(initialChatIds);
  const knownChatIds = new Set(initialChatIds);
  const deliveryModes = new Map<number, DeliveryMode>();
  const digestIntervals = new Map<number, DigestIntervalMinutes>();
  const minimumMarketCaps = new Map<number, number>();
  const maximumMarketCaps = new Map<number, number>();
  const trackWithoutMarketCap = new Map<number, boolean>();
  const holderVisibility = new Map<number, boolean>();
  const creatorHistoryVisibility = new Map<number, boolean>();
  const messageFormats = new Map<number, MessageFormat>();
  const enabledChainsByChat = new Map<number, Set<Chain>>();
  const deliveredCandidates = new Map<number, Set<string>>();
  const tokenUnlockSubscribers = new Set<number>();
  const tokenUnlockNotificationDates = new Map<number, string>();
  const activateDiscovery = (chatId: number) => {
    knownChatIds.add(chatId);
    subscribers.add(chatId);
    tokenUnlockSubscribers.delete(chatId);
  };
  return {
    subscribe(chatId) {
      activateDiscovery(chatId);
    },
    unsubscribe(chatId) {
      knownChatIds.add(chatId);
      subscribers.delete(chatId);
    },
    isSubscribed(chatId) {
      return subscribers.has(chatId);
    },
    deliveryMode(chatId) {
      return deliveryModes.get(chatId) ?? defaultDeliveryMode;
    },
    setDeliveryMode(chatId, mode) {
      activateDiscovery(chatId);
      deliveryModes.set(chatId, mode);
    },
    digestIntervalMinutes(chatId) {
      return digestIntervals.get(chatId) ?? 1;
    },
    setDigestIntervalMinutes(chatId, minutes) {
      activateDiscovery(chatId);
      digestIntervals.set(chatId, minutes);
    },
    minimumMarketCapUsd(chatId) {
      return minimumMarketCaps.get(chatId) ?? defaultMinimumMarketCapUsd;
    },
    setMinimumMarketCapUsd(chatId, value) {
      activateDiscovery(chatId);
      minimumMarketCaps.set(chatId, value);
    },
    maximumMarketCapUsd(chatId) {
      return maximumMarketCaps.get(chatId) ?? defaultMaximumMarketCapUsd;
    },
    setMaximumMarketCapUsd(chatId, value) {
      activateDiscovery(chatId);
      maximumMarketCaps.set(chatId, value);
    },
    trackTokensWithoutMarketCap(chatId) {
      return trackWithoutMarketCap.get(chatId) ?? false;
    },
    setTrackTokensWithoutMarketCap(chatId, enabled) {
      activateDiscovery(chatId);
      trackWithoutMarketCap.set(chatId, enabled);
    },
    showHolders(chatId) {
      return holderVisibility.get(chatId) ?? true;
    },
    setShowHolders(chatId, enabled) {
      activateDiscovery(chatId);
      holderVisibility.set(chatId, enabled);
    },
    showCreatorHistory(chatId) {
      return creatorHistoryVisibility.get(chatId) ?? false;
    },
    setShowCreatorHistory(chatId, enabled) {
      activateDiscovery(chatId);
      creatorHistoryVisibility.set(chatId, enabled);
    },
    messageFormat(chatId) {
      return messageFormats.get(chatId) ?? "LIGHT";
    },
    setMessageFormat(chatId, format) {
      activateDiscovery(chatId);
      messageFormats.set(chatId, format);
    },
    enabledChains(chatId) {
      const enabled = enabledChainsByChat.get(chatId) ?? new Set(defaultEnabledChains);
      return CHAINS.filter((chain) => enabled.has(chain));
    },
    setChainEnabled(chatId, chain, enabled) {
      activateDiscovery(chatId);
      const chains = enabledChainsByChat.get(chatId) ?? new Set(defaultEnabledChains);
      if (enabled) chains.add(chain);
      else chains.delete(chain);
      enabledChainsByChat.set(chatId, chains);
    },
    wasCandidateDelivered(chatId, candidateId) {
      return deliveredCandidates.get(chatId)?.has(candidateId) ?? false;
    },
    markCandidateDelivered(chatId, candidateId) {
      const delivered = deliveredCandidates.get(chatId) ?? new Set<string>();
      delivered.delete(candidateId);
      delivered.add(candidateId);
      while (delivered.size > 5_000) {
        const oldest = delivered.values().next().value;
        if (oldest === undefined) break;
        delivered.delete(oldest);
      }
      deliveredCandidates.set(chatId, delivered);
    },
    clearCandidateDeliveryHistory(chatId) {
      deliveredCandidates.delete(chatId);
    },
    deliveredCandidateIds(chatId) {
      return [...(deliveredCandidates.get(chatId) ?? [])];
    },
    tokenUnlockTracking(chatId) {
      return tokenUnlockSubscribers.has(chatId);
    },
    setTokenUnlockTracking(chatId, enabled) {
      knownChatIds.add(chatId);
      if (enabled) {
        tokenUnlockSubscribers.add(chatId);
        subscribers.delete(chatId);
      } else {
        tokenUnlockSubscribers.delete(chatId);
      }
    },
    tokenUnlockTrackingChatIds() {
      return [...tokenUnlockSubscribers];
    },
    lastTokenUnlockNotificationDate(chatId) {
      return tokenUnlockNotificationDates.get(chatId);
    },
    markTokenUnlockNotificationSent(chatId, date) {
      knownChatIds.add(chatId);
      tokenUnlockNotificationDates.set(chatId, date);
    },
    chatIds() {
      return [...subscribers];
    },
    allChatIds() {
      return [...knownChatIds];
    },
  };
}

interface StoredAudienceEntry {
  chatId: number;
  subscribed?: boolean;
  deliveryMode: DeliveryMode;
  digestIntervalMinutes?: DigestIntervalMinutes;
  minimumMarketCapUsd?: number;
  maximumMarketCapUsd?: number;
  trackTokensWithoutMarketCap?: boolean;
  showHolders?: boolean;
  showCreatorHistory?: boolean;
  messageFormat?: MessageFormat;
  messageFormatSchemaVersion?: 2;
  enabledChains?: Chain[];
  deliveredCandidateIds?: string[];
  tokenUnlockTracking?: boolean;
  lastTokenUnlockNotificationDate?: string;
}

interface StoredDeliveryHistoryEntry {
  chatId: number;
  deliveredCandidateIds: string[];
}

function readStoredAudience(filePath: string): StoredAudienceEntry[] {
  if (!existsSync(filePath)) return [];
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is StoredAudienceEntry => {
      if (typeof entry !== "object" || entry === null) return false;
      const record = entry as Record<string, unknown>;
      return Number.isSafeInteger(record.chatId) &&
        (record.subscribed === undefined || typeof record.subscribed === "boolean") &&
        (record.deliveryMode === "IMMEDIATE" || record.deliveryMode === "ONE_MINUTE_DIGEST") &&
        (record.digestIntervalMinutes === undefined ||
          DIGEST_INTERVAL_MINUTES.includes(record.digestIntervalMinutes as DigestIntervalMinutes)) &&
        (record.minimumMarketCapUsd === undefined ||
          (typeof record.minimumMarketCapUsd === "number" && Number.isFinite(record.minimumMarketCapUsd) && record.minimumMarketCapUsd >= 0)) &&
        (record.maximumMarketCapUsd === undefined ||
          (typeof record.maximumMarketCapUsd === "number" && Number.isFinite(record.maximumMarketCapUsd) && record.maximumMarketCapUsd >= 0)) &&
        (record.trackTokensWithoutMarketCap === undefined || typeof record.trackTokensWithoutMarketCap === "boolean") &&
        (record.showHolders === undefined || typeof record.showHolders === "boolean") &&
        (record.showCreatorHistory === undefined || typeof record.showCreatorHistory === "boolean") &&
        (record.messageFormat === undefined || record.messageFormat === "FULL" || record.messageFormat === "LIGHT") &&
        (record.messageFormatSchemaVersion === undefined || record.messageFormatSchemaVersion === 2) &&
        (record.enabledChains === undefined ||
          (Array.isArray(record.enabledChains) && record.enabledChains.every((chain) =>
            typeof chain === "string" && (CHAINS as readonly string[]).includes(chain)))) &&
        (record.deliveredCandidateIds === undefined ||
          (Array.isArray(record.deliveredCandidateIds) && record.deliveredCandidateIds.every((id) => typeof id === "string"))) &&
        (record.tokenUnlockTracking === undefined || typeof record.tokenUnlockTracking === "boolean") &&
        (record.lastTokenUnlockNotificationDate === undefined ||
          (typeof record.lastTokenUnlockNotificationDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.lastTokenUnlockNotificationDate)));
    });
  } catch {
    return [];
  }
}

function readStoredDeliveryHistory(filePath: string): StoredDeliveryHistoryEntry[] {
  if (!existsSync(filePath)) return [];
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is StoredDeliveryHistoryEntry => {
      if (typeof entry !== "object" || entry === null) return false;
      const record = entry as Record<string, unknown>;
      return Number.isSafeInteger(record.chatId) &&
        Array.isArray(record.deliveredCandidateIds) &&
        record.deliveredCandidateIds.every((id) => typeof id === "string");
    });
  } catch {
    return [];
  }
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, filePath);
}

export function createPersistentTelegramAudience(
  configuredPath: string,
  initialChatIds: Iterable<number> = [],
  defaultDeliveryMode: DeliveryMode = "ONE_MINUTE_DIGEST",
  defaultMinimumMarketCapUsd = 0,
  defaultMaximumMarketCapUsd = 10_000,
  configuredDeliveryHistoryPath = `${configuredPath}.delivery-history`,
  defaultEnabledChains: readonly Chain[] = ["robinhood"],
): TelegramAudience {
  const filePath = resolve(configuredPath);
  const deliveryHistoryPath = resolve(configuredDeliveryHistoryPath);
  const stored = readStoredAudience(filePath);
  const storedDeliveryHistory = readStoredDeliveryHistory(deliveryHistoryPath);
  const audience = createTelegramAudience(
    initialChatIds,
    defaultDeliveryMode,
    defaultMinimumMarketCapUsd,
    defaultMaximumMarketCapUsd,
    defaultEnabledChains,
  );
  const legacyDeliveredCandidates = new Map<number, string[]>();
  stored.forEach(({
    chatId,
    subscribed,
    deliveryMode,
    digestIntervalMinutes,
    minimumMarketCapUsd,
    maximumMarketCapUsd,
    trackTokensWithoutMarketCap,
    showHolders,
    showCreatorHistory,
    messageFormat,
    messageFormatSchemaVersion,
    enabledChains,
    deliveredCandidateIds,
    tokenUnlockTracking,
    lastTokenUnlockNotificationDate,
  }) => {
    audience.setDeliveryMode(chatId, deliveryMode);
    if (digestIntervalMinutes !== undefined) audience.setDigestIntervalMinutes(chatId, digestIntervalMinutes);
    // A maximum is the marker for the new range schema. Older single-minimum
    // entries migrate to the configured default range.
    if (maximumMarketCapUsd !== undefined) {
      if (minimumMarketCapUsd !== undefined) audience.setMinimumMarketCapUsd(chatId, minimumMarketCapUsd);
      audience.setMaximumMarketCapUsd(chatId, maximumMarketCapUsd);
    }
    if (trackTokensWithoutMarketCap !== undefined) {
      audience.setTrackTokensWithoutMarketCap(chatId, trackTokensWithoutMarketCap);
    }
    if (showHolders !== undefined) audience.setShowHolders(chatId, showHolders);
    if (showCreatorHistory !== undefined) audience.setShowCreatorHistory(chatId, showCreatorHistory);
    // Version 1 briefly persisted FULL as an implicit default. Ignore that
    // unversioned value so existing chats migrate to the new LIGHT default.
    if (messageFormatSchemaVersion === 2 && messageFormat !== undefined) {
      audience.setMessageFormat(chatId, messageFormat);
    }
    if (enabledChains !== undefined) {
      for (const chain of CHAINS) audience.setChainEnabled(chatId, chain, enabledChains.includes(chain));
    }
    if (deliveredCandidateIds?.length) legacyDeliveredCandidates.set(chatId, deliveredCandidateIds);
    if (tokenUnlockTracking !== undefined) audience.setTokenUnlockTracking(chatId, tokenUnlockTracking);
    if (lastTokenUnlockNotificationDate !== undefined) {
      audience.markTokenUnlockNotificationSent(chatId, lastTokenUnlockNotificationDate);
    }
    if (subscribed === false) audience.unsubscribe(chatId);
  });

  const separateHistoryChatIds = new Set(storedDeliveryHistory.map((entry) => entry.chatId));
  storedDeliveryHistory.forEach(({ chatId, deliveredCandidateIds }) => {
    deliveredCandidateIds.slice(-5_000).forEach((candidateId) => audience.markCandidateDelivered(chatId, candidateId));
  });
  legacyDeliveredCandidates.forEach((candidateIds, chatId) => {
    if (separateHistoryChatIds.has(chatId)) return;
    candidateIds.slice(-5_000).forEach((candidateId) => audience.markCandidateDelivered(chatId, candidateId));
  });

  const persistAudience = () => {
    const data = audience.allChatIds().map((chatId) => ({
      chatId,
      subscribed: audience.isSubscribed(chatId),
      deliveryMode: audience.deliveryMode(chatId),
      digestIntervalMinutes: audience.digestIntervalMinutes(chatId),
      minimumMarketCapUsd: audience.minimumMarketCapUsd(chatId),
      maximumMarketCapUsd: audience.maximumMarketCapUsd(chatId),
      trackTokensWithoutMarketCap: audience.trackTokensWithoutMarketCap(chatId),
      showHolders: audience.showHolders(chatId),
      showCreatorHistory: audience.showCreatorHistory(chatId),
      messageFormat: audience.messageFormat(chatId),
      messageFormatSchemaVersion: 2 as const,
      enabledChains: audience.enabledChains(chatId),
      tokenUnlockTracking: audience.tokenUnlockTracking(chatId),
      lastTokenUnlockNotificationDate: audience.lastTokenUnlockNotificationDate(chatId),
    }));
    writeJsonAtomically(filePath, data);
  };
  const persistDeliveryHistory = () => {
    const data = audience.chatIds()
      .map((chatId) => ({ chatId, deliveredCandidateIds: audience.deliveredCandidateIds(chatId) }))
      .filter((entry) => entry.deliveredCandidateIds.length > 0);
    writeJsonAtomically(deliveryHistoryPath, data);
  };
  persistAudience();
  persistDeliveryHistory();

  return {
    subscribe(chatId) {
      audience.subscribe(chatId);
      persistAudience();
    },
    unsubscribe(chatId) {
      audience.unsubscribe(chatId);
      persistAudience();
    },
    isSubscribed: (chatId) => audience.isSubscribed(chatId),
    deliveryMode: (chatId) => audience.deliveryMode(chatId),
    setDeliveryMode(chatId, mode) {
      audience.setDeliveryMode(chatId, mode);
      persistAudience();
    },
    digestIntervalMinutes: (chatId) => audience.digestIntervalMinutes(chatId),
    setDigestIntervalMinutes(chatId, minutes) {
      audience.setDigestIntervalMinutes(chatId, minutes);
      persistAudience();
    },
    minimumMarketCapUsd: (chatId) => audience.minimumMarketCapUsd(chatId),
    setMinimumMarketCapUsd(chatId, value) {
      audience.setMinimumMarketCapUsd(chatId, value);
      persistAudience();
    },
    maximumMarketCapUsd: (chatId) => audience.maximumMarketCapUsd(chatId),
    setMaximumMarketCapUsd(chatId, value) {
      audience.setMaximumMarketCapUsd(chatId, value);
      persistAudience();
    },
    trackTokensWithoutMarketCap: (chatId) => audience.trackTokensWithoutMarketCap(chatId),
    setTrackTokensWithoutMarketCap(chatId, enabled) {
      audience.setTrackTokensWithoutMarketCap(chatId, enabled);
      persistAudience();
    },
    showHolders: (chatId) => audience.showHolders(chatId),
    setShowHolders(chatId, enabled) {
      audience.setShowHolders(chatId, enabled);
      persistAudience();
    },
    showCreatorHistory: (chatId) => audience.showCreatorHistory(chatId),
    setShowCreatorHistory(chatId, enabled) {
      audience.setShowCreatorHistory(chatId, enabled);
      persistAudience();
    },
    messageFormat: (chatId) => audience.messageFormat(chatId),
    setMessageFormat(chatId, format) {
      audience.setMessageFormat(chatId, format);
      persistAudience();
    },
    enabledChains: (chatId) => audience.enabledChains(chatId),
    setChainEnabled(chatId, chain, enabled) {
      audience.setChainEnabled(chatId, chain, enabled);
      persistAudience();
    },
    wasCandidateDelivered: (chatId, candidateId) => audience.wasCandidateDelivered(chatId, candidateId),
    markCandidateDelivered(chatId, candidateId) {
      audience.markCandidateDelivered(chatId, candidateId);
      persistDeliveryHistory();
    },
    clearCandidateDeliveryHistory(chatId) {
      audience.clearCandidateDeliveryHistory(chatId);
      persistDeliveryHistory();
    },
    deliveredCandidateIds: (chatId) => audience.deliveredCandidateIds(chatId),
    tokenUnlockTracking: (chatId) => audience.tokenUnlockTracking(chatId),
    setTokenUnlockTracking(chatId, enabled) {
      audience.setTokenUnlockTracking(chatId, enabled);
      persistAudience();
    },
    tokenUnlockTrackingChatIds: () => audience.tokenUnlockTrackingChatIds(),
    lastTokenUnlockNotificationDate: (chatId) => audience.lastTokenUnlockNotificationDate(chatId),
    markTokenUnlockNotificationSent(chatId, date) {
      audience.markTokenUnlockNotificationSent(chatId, date);
      persistAudience();
    },
    chatIds: () => audience.chatIds(),
    allChatIds: () => audience.allChatIds(),
  };
}

export interface CandidateDigestQueue {
  enqueue(chatId: number, candidate: TokenCandidate): void;
  drain(chatId: number): readonly TokenCandidate[];
}

export function createCandidateDigestQueue(): CandidateDigestQueue {
  const queues = new Map<number, Map<string, TokenCandidate>>();
  return {
    enqueue(chatId, candidate) {
      const queue = queues.get(chatId) ?? new Map<string, TokenCandidate>();
      queue.set(candidate.id, candidate);
      queues.set(chatId, queue);
    },
    drain(chatId) {
      const queue = [...(queues.get(chatId)?.values() ?? [])];
      queues.delete(chatId);
      return queue;
    },
  };
}

export function createCandidateStore(): CandidateStore {
  const candidates = new Map<string, TokenCandidate>();
  const ignored = new Set<string>();
  return {
    put(candidate) {
      candidates.set(candidate.id, candidate);
      candidates.set(candidateCallbackId(candidate.id), candidate);
    },
    get(id) {
      return ignored.has(id) ? undefined : candidates.get(id);
    },
    ignore(id) {
      if (!candidates.has(id)) return false;
      ignored.add(id);
      return true;
    },
  };
}

export const basicHealthService: HealthService = {
  async check() {
    return {
      status: "degraded",
      checks: { process: "up", telegram: "up", database: "not_configured", redis: "not_configured" },
    };
  },
};

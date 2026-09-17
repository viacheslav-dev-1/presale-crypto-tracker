import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistentTelegramAudience } from "../src/bot/services.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("persistent Telegram audience", () => {
  it("preserves subscriptions, digest mode, and digest interval across restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "pre-fomo-audience-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "audience.json");
    const historyFile = join(directory, "delivery-history.json");
    const first = createPersistentTelegramAudience(file, [], "ONE_MINUTE_DIGEST", 0, 10_000, historyFile);
    first.subscribe(123);
    first.setDeliveryMode(123, "ONE_MINUTE_DIGEST");
    first.setDigestIntervalMinutes(123, 5);
    first.setMinimumMarketCapUsd(123, 25_000);
    first.setMaximumMarketCapUsd(123, 75_000);
    first.setTrackTokensWithoutMarketCap(123, true);
    first.setShowHolders(123, false);
    first.setShowCreatorHistory(123, true);
    first.setMessageFormat(123, "LIGHT");
    first.setChainEnabled(123, "solana", true);
    first.setChainEnabled(123, "robinhood", false);
    first.markCandidateDelivered(123, "solana:mint");
    first.setTokenUnlockTracking(123, true);
    first.markTokenUnlockNotificationSent(123, "2026-09-18");

    const storedAudience = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    const storedHistory = JSON.parse(readFileSync(historyFile, "utf8")) as Array<Record<string, unknown>>;
    expect(storedAudience[0]).not.toHaveProperty("deliveredCandidateIds");
    expect(storedHistory[0]).toMatchObject({ chatId: 123, deliveredCandidateIds: ["solana:mint"] });

    const restarted = createPersistentTelegramAudience(file, [], "ONE_MINUTE_DIGEST", 0, 10_000, historyFile);
    expect(restarted.isSubscribed(123)).toBe(false);
    expect(restarted.deliveryMode(123)).toBe("ONE_MINUTE_DIGEST");
    expect(restarted.digestIntervalMinutes(123)).toBe(5);
    expect(restarted.minimumMarketCapUsd(123)).toBe(25_000);
    expect(restarted.maximumMarketCapUsd(123)).toBe(75_000);
    expect(restarted.trackTokensWithoutMarketCap(123)).toBe(true);
    expect(restarted.showHolders(123)).toBe(false);
    expect(restarted.showCreatorHistory(123)).toBe(true);
    expect(restarted.messageFormat(123)).toBe("LIGHT");
    expect(restarted.enabledChains(123)).toEqual(["solana"]);
    expect(restarted.wasCandidateDelivered(123, "solana:mint")).toBe(true);
    expect(restarted.isSubscribed(123)).toBe(false);
    expect(restarted.tokenUnlockTracking(123)).toBe(true);
    expect(restarted.tokenUnlockTrackingChatIds()).toEqual([123]);
    expect(restarted.lastTokenUnlockNotificationDate(123)).toBe("2026-09-18");
  });

  it("migrates legacy audience delivery IDs and can clear them independently", () => {
    const directory = mkdtempSync(join(tmpdir(), "pre-fomo-audience-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "audience.json");
    const historyFile = join(directory, "delivery-history.json");
    writeFileSync(file, JSON.stringify([{
      chatId: 123,
      deliveryMode: "IMMEDIATE",
      deliveredCandidateIds: ["bsc:token"],
    }]));

    const audience = createPersistentTelegramAudience(file, [], "ONE_MINUTE_DIGEST", 0, 10_000, historyFile);
    expect(audience.wasCandidateDelivered(123, "bsc:token")).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))[0]).not.toHaveProperty("deliveredCandidateIds");
    expect(JSON.parse(readFileSync(historyFile, "utf8"))[0]).toMatchObject({
      chatId: 123,
      deliveredCandidateIds: ["bsc:token"],
    });

    audience.clearCandidateDeliveryHistory(123);
    expect(audience.wasCandidateDelivered(123, "bsc:token")).toBe(false);
    expect(JSON.parse(readFileSync(historyFile, "utf8"))).toEqual([]);
  });

  it("migrates the old single-threshold schema to the new default range", () => {
    const directory = mkdtempSync(join(tmpdir(), "pre-fomo-audience-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "audience.json");
    writeFileSync(file, JSON.stringify([{
      chatId: 123,
      deliveryMode: "ONE_MINUTE_DIGEST",
      digestIntervalMinutes: 1,
      minimumMarketCapUsd: 10_000,
      messageFormat: "FULL",
    }]));

    const audience = createPersistentTelegramAudience(file);
    expect(audience.minimumMarketCapUsd(123)).toBe(0);
    expect(audience.maximumMarketCapUsd(123)).toBe(10_000);
    expect(audience.showHolders(123)).toBe(true);
    expect(audience.showCreatorHistory(123)).toBe(false);
    expect(audience.messageFormat(123)).toBe("LIGHT");
    expect(audience.enabledChains(123)).toEqual(["robinhood"]);
  });

  it("uses Robinhood as the only default chain for a new chat", () => {
    const directory = mkdtempSync(join(tmpdir(), "pre-fomo-audience-"));
    temporaryDirectories.push(directory);
    const audience = createPersistentTelegramAudience(join(directory, "audience.json"));
    expect(audience.enabledChains(999)).toEqual(["robinhood"]);
  });
});

import { InlineKeyboard } from "grammy";
import { createHash } from "node:crypto";
import { CHAINS, type Chain, type TokenCandidate } from "../domain/token-candidate.js";
import { chainLabel } from "./formatters.js";
import type { DeliveryMode, DigestIntervalMinutes, MessageFormat } from "./services.js";
import { fomoTokenUrl, tokenExplorerUrl } from "./links.js";

export { fomoTokenUrl, tokenExplorerUrl } from "./links.js";

export function chainsKeyboard(enabledChains: readonly Chain[]): InlineKeyboard {
  const enabled = new Set(enabledChains);
  const keyboard = new InlineKeyboard();
  for (const chain of CHAINS) {
    keyboard.text(`${chainLabel(chain)} ${enabled.has(chain) ? "✅" : "❌"}`, `chain:${chain}`).row();
  }
  return keyboard.text("⬅️ Main menu", "menu:home");
}

export function mainMenuKeyboard(options: {
  subscribed: boolean;
  deliveryMode: DeliveryMode;
  digestIntervalMinutes: DigestIntervalMinutes;
  minimumMarketCapUsd: number;
  maximumMarketCapUsd: number;
  showHolders: boolean;
  showCreatorHistory: boolean;
  messageFormat: MessageFormat;
}): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("📊 Status", "menu:status")
    .text("🩺 Health", "menu:health")
    .row()
    .text(options.subscribed ? "🔕 Unsubscribe alerts" : "🔔 Subscribe alerts", options.subscribed ? "menu:unsubscribe" : "menu:subscribe")
    .row()
    .text(options.deliveryMode === "IMMEDIATE"
      ? "📨 Delivery: Instant"
      : `🗞 Delivery: ${options.digestIntervalMinutes}-min digest`, "menu:delivery")
    .row()
    .text(
      `💰 Cap: $${options.minimumMarketCapUsd.toLocaleString("en-US")}–$${options.maximumMarketCapUsd.toLocaleString("en-US")}`,
      "menu:marketcap",
    )
    .row()
    .text(`👥 Holders: ${options.showHolders ? "ON ✅" : "OFF ❌"}`, "holders:toggle")
    .row()
    .text(options.showCreatorHistory ? "🧑 Creator History: ON ✅" : "🧑 Enable Creator History ❌", "creator_history:toggle")
    .row()
    .text(`📝 Message format: ${options.messageFormat}`, "message_format:toggle")
    .row()
    .text("ℹ️ Help", "menu:help")
    .row()
    .text("⛓ Chains", "menu:chains");
  return keyboard;
}

export function marketCapKeyboard(trackWithoutMarketCap: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text("✏️ Set Min", "marketcap:set:min")
    .text("✏️ Set Max", "marketcap:set:max")
    .row()
    .text(
      `Track tokens without cap: ${trackWithoutMarketCap ? "ON ✅" : "OFF ❌"}`,
      "marketcap:unknown:toggle",
    )
    .row()
    .text("⬅️ Main menu", "menu:home");
}

export function deliveryKeyboard(current: DeliveryMode, intervalMinutes: DigestIntervalMinutes): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text(`Instant${current === "IMMEDIATE" ? " ✅" : ""}`, "delivery:IMMEDIATE")
    .row()
    .text(`Digest every ${intervalMinutes} min${current === "ONE_MINUTE_DIGEST" ? " ✅" : ""}`, "delivery:ONE_MINUTE_DIGEST")
    .row();
  for (const minutes of [1, 2, 5, 10] as const) {
    keyboard.text(`${minutes} min${intervalMinutes === minutes ? " ✅" : ""}`, `digest_interval:${minutes}`);
    if (minutes === 2) keyboard.row();
  }
  return keyboard.row().text("⬅️ Main menu", "menu:home");
}

export function candidateKeyboard(candidate: TokenCandidate, light = false): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const callbackId = candidateCallbackId(candidate.id);
  if (light) {
    return keyboard.text("DETAILS", `details:${callbackId}`);
  }
  return keyboard
    .url("🔥 OPEN IN FOMO", fomoTokenUrl(candidate))
    .url("🔎 EXPLORER", tokenExplorerUrl(candidate))
    .row()
    .text("🔄 REFRESH HOLDERS", `holders:${callbackId}`);
}

export function lightDigestKeyboard(candidates: readonly TokenCandidate[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  candidates.forEach((candidate, index) => {
    const token = (candidate.symbol ?? candidate.name ?? "TOKEN").slice(0, 18);
    keyboard.text(`DETAILS · ${token}`, `details:${candidateCallbackId(candidate.id)}`);
    if (index < candidates.length - 1) keyboard.row();
  });
  return keyboard;
}

export function candidateCallbackId(id: string): string {
  return Buffer.byteLength(id, "utf8") <= 48
    ? id
    : createHash("sha256").update(id).digest("base64url").slice(0, 22);
}

export function isChain(value: string): value is Chain {
  return (CHAINS as readonly string[]).includes(value);
}

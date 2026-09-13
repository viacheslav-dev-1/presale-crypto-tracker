import { describe, expect, it } from "vitest";
import { createBotState } from "../src/bot/state.js";

describe("bot state", () => {
  it("uses Discovery Only mode and records detections", () => {
    const state = createBotState();
    state.recordDetection();
    expect(state.snapshot()).toMatchObject({
      mode: "DISCOVERY_ONLY",
      detections: 1,
    });
  });
});

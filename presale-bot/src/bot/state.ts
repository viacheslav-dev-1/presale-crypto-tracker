export interface BotSnapshot {
  mode: "DISCOVERY_ONLY";
  startedAt: Date;
  detections: number;
}

export interface BotState {
  snapshot(): BotSnapshot;
  recordDetection(): void;
}

export function createBotState(): BotState {
  let detections = 0;
  const startedAt = new Date();

  const snapshot = (): BotSnapshot => ({
    mode: "DISCOVERY_ONLY",
    startedAt,
    detections,
  });

  return {
    snapshot,
    recordDetection() {
      detections += 1;
    },
  };
}

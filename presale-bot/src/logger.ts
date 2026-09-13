import pino from "pino";
import type { AppConfig } from "./config.js";

export function createLogger(config: Pick<AppConfig, "nodeEnv" | "logLevel">) {
  const baseOptions = {
    level: config.logLevel,
    redact: {
      paths: ["token", "telegramToken", "privateKey", "seed", "mnemonic", "*.token"],
      censor: "[REDACTED]",
    },
  };
  return config.nodeEnv === "development"
    ? pino({ ...baseOptions, transport: { target: "pino-pretty", options: { colorize: true } } })
    : pino(baseOptions);
}

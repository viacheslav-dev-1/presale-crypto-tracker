import { describe, expect, it } from "vitest";
import { createEvmClient } from "../src/chains/evm/client.js";
import type { EvmChainConfig } from "../src/config/evm.js";

const httpConfig: EvmChainConfig = {
  id: 8453,
  key: "base",
  name: "Base",
  httpRpcUrl: "https://rpc.example.test",
  nativeSymbol: "ETH",
  quoteTokens: [],
  usdStableTokens: [],
  dexFactories: [],
  pollingIntervalMs: 1_000,
};

describe("createEvmClient", () => {
  it("disables stateful HTTP filters so viem falls back to eth_getLogs polling", async () => {
    const client = createEvmClient(httpConfig) as unknown as {
      request(parameters: { method: string; params: readonly unknown[] }): Promise<unknown>;
    };

    await expect(client.request({ method: "eth_newFilter", params: [{}] }))
      .rejects.toThrow("Stateful RPC filters are disabled");
  });
});

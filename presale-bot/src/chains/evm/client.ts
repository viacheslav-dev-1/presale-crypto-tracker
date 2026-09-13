import { createPublicClient, defineChain, http, webSocket, type Transport } from "viem";
import { WebSocket as NodeWebSocket } from "ws";
import type { EvmChainConfig } from "../../config/evm.js";
import type { EvmDetectorClient } from "./detector.js";

/**
 * viem's WebSocket transport expects a browser-compatible global constructor.
 * Node.js only provides that global in newer releases, so install the `ws`
 * implementation before viem lazily resolves its socket transport.
 */
export function ensureWebSocketConstructor(): void {
  if (typeof globalThis.WebSocket === "function") return;

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: NodeWebSocket,
  });
}

/**
 * viem normally uses stateful `eth_newFilter`/`eth_getFilterChanges` polling
 * over HTTP. Load-balanced public RPCs can lose those server-side filter IDs.
 * Reject filter creation locally so viem uses its stateless `eth_getLogs`
 * block-range fallback instead.
 */
export function statelessHttp(url: string): Transport {
  const transport = http(url);
  return (options) => {
    const configured = transport(options);
    const request: typeof configured.request = async (parameters) => {
      if (parameters.method === "eth_newFilter") {
        throw new Error("Stateful RPC filters are disabled; use eth_getLogs polling");
      }
      return configured.request(parameters);
    };
    return { ...configured, request };
  };
}

export function createEvmClient(config: EvmChainConfig): EvmDetectorClient {
  const chain = defineChain({
    id: config.id,
    name: config.name,
    nativeCurrency: { name: config.nativeSymbol, symbol: config.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [config.httpRpcUrl] } },
  });
  if (config.wsRpcUrl) ensureWebSocketConstructor();
  const transport = config.wsRpcUrl ? webSocket(config.wsRpcUrl) : statelessHttp(config.httpRpcUrl);
  return createPublicClient({ chain, transport }) as unknown as EvmDetectorClient;
}

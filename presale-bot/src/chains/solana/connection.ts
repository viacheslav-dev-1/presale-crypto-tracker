import { Connection } from "@solana/web3.js";
import type { AppConfig } from "../../config.js";

export function createSolanaConnection(config: AppConfig["solana"]): Connection {
  if (!config.rpcHttp) throw new Error("SOLANA_RPC_HTTP is required for Solana discovery");
  return new Connection(config.rpcHttp, {
    commitment: config.commitment,
    // Optional enrichment calls handle throttling themselves. The SDK's
    // unbounded-looking console retry loop can otherwise delay fresh alerts.
    disableRetryOnRateLimit: true,
    ...(config.rpcWs ? { wsEndpoint: config.rpcWs } : {}),
  });
}

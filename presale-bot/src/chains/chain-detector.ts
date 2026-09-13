export interface ChainDetector {
  start(): Promise<void>;
  stop(): Promise<void>;
}

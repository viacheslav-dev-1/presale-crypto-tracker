import { PublicKey } from "@solana/web3.js";
import { CREATE_EVENT_DISCRIMINATOR, TRADE_EVENT_DISCRIMINATOR } from "../../src/chains/solana/pumpfun/decoder.js";

const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const string = (value: string) => {
  const content = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(content.length);
  return Buffer.concat([length, content]);
};
const u64 = (value: bigint) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
};
const i64 = (value: bigint) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(value);
  return bytes;
};

export function pumpCreateEventFixture(): Buffer {
  return Buffer.concat([
    CREATE_EVENT_DISCRIMINATOR,
    string("Test Coin"),
    string("TEST"),
    string("https://metadata.example/test.json"),
    key(1).toBuffer(),
    key(2).toBuffer(),
    key(3).toBuffer(),
    key(4).toBuffer(),
    i64(1_789_033_600n),
    u64(1_000_000n),
    u64(30_000_000_000n),
    u64(800_000n),
    u64(1_000_000n),
    key(5).toBuffer(),
    Buffer.from([0, 1]),
    new Uint8Array(32),
    u64(30_000_000_000n),
  ]);
}

export function pumpTradeEventFixture(virtualQuoteReserves = 60_000_000_000n): Buffer {
  return Buffer.concat([
    TRADE_EVENT_DISCRIMINATOR,
    key(1).toBuffer(),
    u64(1_000_000_000n),
    u64(100_000n),
    Buffer.from([1]),
    key(3).toBuffer(),
    i64(1_789_033_601n),
    u64(virtualQuoteReserves),
    u64(1_000_000n),
  ]);
}

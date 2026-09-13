import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  CREATE_EVENT_DISCRIMINATOR,
  CREATE_V2_INSTRUCTION_DISCRIMINATOR,
  decodePumpCreateEvent,
  decodePumpCreateEventLog,
  decodePumpCreateInstruction,
  decodePumpTradeEvent,
  decodePumpBondingCurve,
} from "../src/chains/solana/pumpfun/decoder.js";
import { pumpCreateEventFixture, pumpTradeEventFixture } from "./fixtures/pump.js";

const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const string = (value: string) => {
  const content = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(content.length);
  return Buffer.concat([length, content]);
};
describe("Pump decoder", () => {
  it("decodes the current official CreateEvent layout", () => {
    const decoded = decodePumpCreateEvent(pumpCreateEventFixture());
    expect(decoded).toMatchObject({
      variant: "create_event",
      mint: key(1).toBase58(),
      bondingCurve: key(2).toBase58(),
      user: key(3).toBase58(),
      creator: key(4).toBase58(),
      name: "Test Coin",
      symbol: "TEST",
      realTokenReserves: 800_000n,
      isMayhemMode: false,
      isCashbackEnabled: true,
    });
    expect(decoded?.quoteMint).toBeUndefined();
    expect(decoded?.onChainTimestamp?.toISOString()).toBe("2026-09-10T09:46:40.000Z");
  });

  it("extracts CreateEvent only from matching Program data logs", () => {
    expect(decodePumpCreateEventLog("Program log: Instruction: CreateV2")).toBeNull();
    expect(decodePumpCreateEventLog(`Program data: ${pumpCreateEventFixture().toString("base64")}`)?.mint).toBe(key(1).toBase58());
  });

  it("decodes create_v2 instruction data and account positions", () => {
    const accounts = Array.from({ length: 17 }, (_, index) => key(index + 1).toBase58());
    const data = Buffer.concat([
      CREATE_V2_INSTRUCTION_DISCRIMINATOR,
      string("V2 Coin"),
      string("V2"),
      string("ipfs://metadata"),
      key(20).toBuffer(),
      Buffer.from([1, 0]),
    ]);
    expect(decodePumpCreateInstruction(data, accounts)).toMatchObject({
      variant: "create_v2",
      mint: accounts[0],
      bondingCurve: accounts[2],
      associatedBondingCurve: accounts[3],
      user: accounts[5],
      creator: key(20).toBase58(),
      tokenProgram: accounts[7],
      isMayhemMode: true,
      isCashbackEnabled: false,
      quoteMint: accounts[16],
    });
  });

  it("rejects malformed lengths without allocating unbounded buffers", () => {
    const malformed = Buffer.concat([CREATE_EVENT_DISCRIMINATOR, Buffer.from([255, 255, 255, 127])]);
    expect(() => decodePumpCreateEvent(malformed)).toThrow(/exceeds 32 bytes/);
  });

  it("decodes reserve updates from the official TradeEvent prefix", () => {
    expect(decodePumpTradeEvent(pumpTradeEventFixture())).toMatchObject({
      mint: key(1).toBase58(),
      virtualQuoteReserves: 60_000_000_000n,
      virtualTokenReserves: 1_000_000n,
    });
  });

  it("decodes capitalization inputs from a bonding-curve account", () => {
    const data = Buffer.alloc(8 + 8 * 5 + 1);
    data.writeBigUInt64LE(1_073_000_000_000_000n, 8);
    data.writeBigUInt64LE(30_000_000_000n, 16);
    data.writeBigUInt64LE(793_100_000_000_000n, 24);
    data.writeBigUInt64LE(0n, 32);
    data.writeBigUInt64LE(1_000_000_000_000_000n, 40);
    expect(decodePumpBondingCurve(data)).toMatchObject({
      virtualTokenReserves: 1_073_000_000_000_000n,
      virtualQuoteReserves: 30_000_000_000n,
      tokenTotalSupply: 1_000_000_000_000_000n,
    });
  });
});

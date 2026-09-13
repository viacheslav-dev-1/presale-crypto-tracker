import { PublicKey } from "@solana/web3.js";

// Verified 2026-09-10 against pump-fun/pump-public-docs/idl/pump.json.
export const CREATE_INSTRUCTION_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);
export const CREATE_V2_INSTRUCTION_DISCRIMINATOR = Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]);
export const CREATE_EVENT_DISCRIMINATOR = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
export const TRADE_EVENT_DISCRIMINATOR = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);

export interface PumpCreation {
  variant: "create" | "create_v2" | "create_event";
  mint: string;
  bondingCurve: string;
  associatedBondingCurve?: string;
  creator: string;
  user?: string;
  name: string;
  symbol: string;
  uri: string;
  tokenProgram?: string;
  quoteMint?: string;
  onChainTimestamp?: Date;
  virtualTokenReserves?: bigint;
  virtualQuoteReserves?: bigint;
  realTokenReserves?: bigint;
  tokenTotalSupply?: bigint;
  isMayhemMode?: boolean;
  isCashbackEnabled?: boolean;
}

export interface PumpTrade {
  mint: string;
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
}

export interface PumpBondingCurve {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
}

class BorshReader {
  private offset = 0;

  constructor(private readonly data: Buffer) {}

  remaining(): number {
    return this.data.length - this.offset;
  }

  bytes(length: number): Buffer {
    if (length < 0 || this.remaining() < length) throw new Error("Truncated Pump instruction/event data");
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  string(maxLength: number): string {
    const length = this.u32();
    if (length > maxLength) throw new Error(`Pump string exceeds ${maxLength} bytes`);
    return this.bytes(length).toString("utf8");
  }

  publicKey(): string {
    return new PublicKey(this.bytes(32)).toBase58();
  }

  u8(): number {
    return this.bytes(1).readUInt8(0);
  }

  bool(): boolean {
    const value = this.u8();
    if (value !== 0 && value !== 1) throw new Error("Invalid Pump boolean");
    return value === 1;
  }

  u32(): number {
    return this.bytes(4).readUInt32LE(0);
  }

  u64(): bigint {
    return this.bytes(8).readBigUInt64LE(0);
  }

  i64(): bigint {
    return this.bytes(8).readBigInt64LE(0);
  }
}

const DEFAULT_PUBLIC_KEY = new PublicKey(new Uint8Array(32)).toBase58();
const optionalPublicKey = (key: string): string | undefined => key === DEFAULT_PUBLIC_KEY ? undefined : key;

export function decodePumpCreateInstruction(data: Uint8Array, accounts: readonly string[]): PumpCreation | null {
  const bytes = Buffer.from(data);
  if (bytes.length < 8) return null;
  const discriminator = bytes.subarray(0, 8);
  const isCreate = discriminator.equals(CREATE_INSTRUCTION_DISCRIMINATOR);
  const isCreateV2 = discriminator.equals(CREATE_V2_INSTRUCTION_DISCRIMINATOR);
  if (!isCreate && !isCreateV2) return null;
  if (accounts.length < 8) throw new Error("Pump create instruction has too few accounts");

  const reader = new BorshReader(bytes.subarray(8));
  const name = reader.string(32);
  const symbol = reader.string(13);
  const uri = reader.string(200);
  const creator = reader.publicKey();
  const common = {
    variant: isCreateV2 ? "create_v2" as const : "create" as const,
    mint: accounts[0]!,
    bondingCurve: accounts[2]!,
    associatedBondingCurve: accounts[3]!,
    creator,
    user: accounts[isCreateV2 ? 5 : 7]!,
    tokenProgram: accounts[isCreateV2 ? 7 : 9]!,
    name,
    symbol,
    uri,
  };

  if (!isCreateV2) return common;
  const isMayhemMode = reader.bool();
  // OptionBool is a one-field bool struct in the current official IDL.
  const isCashbackEnabled = reader.remaining() > 0 ? reader.bool() : undefined;
  const quoteMint = accounts.length >= 17 ? optionalPublicKey(accounts[16]!) : undefined;
  return {
    ...common,
    isMayhemMode,
    ...(isCashbackEnabled !== undefined ? { isCashbackEnabled } : {}),
    ...(quoteMint ? { quoteMint } : {}),
  };
}

export function decodePumpCreateEvent(data: Uint8Array): PumpCreation | null {
  const bytes = Buffer.from(data);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(CREATE_EVENT_DISCRIMINATOR)) return null;
  const reader = new BorshReader(bytes.subarray(8));
  const name = reader.string(32);
  const symbol = reader.string(13);
  const uri = reader.string(200);
  const mint = reader.publicKey();
  const bondingCurve = reader.publicKey();
  const user = reader.publicKey();
  const creator = reader.publicKey();
  const timestampSeconds = reader.i64();
  const virtualTokenReserves = reader.u64();
  const virtualQuoteReservesLegacy = reader.u64();
  const realTokenReserves = reader.u64();
  const tokenTotalSupply = reader.u64();

  // Fields after token_total_supply were added to the backwards-compatible event.
  const tokenProgram = reader.remaining() >= 32 ? reader.publicKey() : undefined;
  const isMayhemMode = reader.remaining() >= 1 ? reader.bool() : undefined;
  const isCashbackEnabled = reader.remaining() >= 1 ? reader.bool() : undefined;
  const quoteMintRaw = reader.remaining() >= 32 ? reader.publicKey() : undefined;
  const virtualQuoteReserves = reader.remaining() >= 8 ? reader.u64() : virtualQuoteReservesLegacy;
  const milliseconds = timestampSeconds * 1_000n;
  const timestampIsSafe = milliseconds <= BigInt(Number.MAX_SAFE_INTEGER) && milliseconds >= BigInt(Number.MIN_SAFE_INTEGER);

  return {
    variant: "create_event",
    mint,
    bondingCurve,
    creator,
    user,
    name,
    symbol,
    uri,
    virtualTokenReserves,
    virtualQuoteReserves,
    realTokenReserves,
    tokenTotalSupply,
    ...(tokenProgram ? { tokenProgram } : {}),
    ...(isMayhemMode !== undefined ? { isMayhemMode } : {}),
    ...(isCashbackEnabled !== undefined ? { isCashbackEnabled } : {}),
    ...(quoteMintRaw && optionalPublicKey(quoteMintRaw) ? { quoteMint: quoteMintRaw } : {}),
    ...(timestampIsSafe ? { onChainTimestamp: new Date(Number(milliseconds)) } : {}),
  };
}

export function decodePumpCreateEventLog(log: string): PumpCreation | null {
  const prefix = "Program data: ";
  if (!log.startsWith(prefix)) return null;
  try {
    return decodePumpCreateEvent(Buffer.from(log.slice(prefix.length), "base64"));
  } catch {
    return null;
  }
}

export function decodePumpTradeEvent(data: Uint8Array): PumpTrade | null {
  const bytes = Buffer.from(data);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(TRADE_EVENT_DISCRIMINATOR)) return null;
  const reader = new BorshReader(bytes.subarray(8));
  const mint = reader.publicKey();
  reader.u64(); // amount paid in the legacy SOL quote
  reader.u64(); // token amount
  reader.bool();
  reader.publicKey(); // user
  reader.i64(); // timestamp
  const virtualQuoteReserves = reader.u64();
  const virtualTokenReserves = reader.u64();
  return { mint, virtualTokenReserves, virtualQuoteReserves };
}

export function decodePumpTradeEventLog(log: string): PumpTrade | null {
  const prefix = "Program data: ";
  if (!log.startsWith(prefix)) return null;
  try {
    return decodePumpTradeEvent(Buffer.from(log.slice(prefix.length), "base64"));
  } catch {
    return null;
  }
}

export function decodePumpBondingCurve(data: Uint8Array): PumpBondingCurve {
  const reader = new BorshReader(Buffer.from(data));
  reader.bytes(8); // Anchor account discriminator
  const virtualTokenReserves = reader.u64();
  const virtualQuoteReserves = reader.u64();
  const realTokenReserves = reader.u64();
  reader.u64(); // real quote reserves
  const tokenTotalSupply = reader.u64();
  return { virtualTokenReserves, virtualQuoteReserves, realTokenReserves, tokenTotalSupply };
}

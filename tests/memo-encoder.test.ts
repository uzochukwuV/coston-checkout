import { describe, it, expect } from "vitest";
import {
  encodeDirectMintingMemo,
  decodeDirectMintingMemo,
  encodeDirectMintingExMemo,
  decodeDirectMintingExMemo,
  encodeFeMemo,
  decodeFeMemo,
  encodeFfMemo,
  decodeFfMemo,
  detectMemoKind,
  normalizeHexNoPrefix,
  bigintToHexBE,
  hexBEToBigInt,
  DIRECT_MINTING_PREFIX,
  DIRECT_MINTING_EX_PREFIX,
  OP_FE_CUSTOM,
  OP_FF_MEMO_CUSTOM,
  XRPL_MEMO_MAX_BYTES,
} from "../src/memo/encoder.js";

const RECIPIENT = "0xf5488132432118596fa13800b68df4c0ff25131d" as const;
const EXECUTOR = "0x000000000000000000000000000000000000dEaD" as const;
const USEROP_HASH = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as const;

describe("normalizeHexNoPrefix", () => {
  it("strips 0x and lowercases", () => {
    expect(normalizeHexNoPrefix("0xABCDEF")).toBe("abcdef");
    expect(normalizeHexNoPrefix("ABCDEF")).toBe("abcdef");
    expect(normalizeHexNoPrefix("0xabcdef")).toBe("abcdef");
  });
  it("rejects non-hex", () => {
    expect(() => normalizeHexNoPrefix("0xZZZZ")).toThrow();
  });
});

describe("bigintToHexBE / hexBEToBigInt", () => {
  it("round-trips values", () => {
    expect(hexBEToBigInt(bigintToHexBE(255n, 1))).toBe(255n);
    expect(hexBEToBigInt(bigintToHexBE(0n, 8))).toBe(0n);
    expect(hexBEToBigInt(bigintToHexBE(123456789n, 8))).toBe(123456789n);
  });
  it("pads to exact byte length", () => {
    expect(bigintToHexBE(1n, 8)).toBe("0000000000000001");
    expect(bigintToHexBE(255n, 1)).toBe("ff");
  });
  it("throws on overflow", () => {
    expect(() => bigintToHexBE(256n, 1)).toThrow();
  });
  it("throws on negative", () => {
    expect(() => bigintToHexBE(-1n, 1)).toThrow();
  });
});

// --- 1. DIRECT_MINTING (32 bytes) ---

describe("DIRECT_MINTING memo (32 bytes)", () => {
  it("matches the skill's documented format", () => {
    const memo = encodeDirectMintingMemo(RECIPIENT);
    // prefix(8) + zeros(4) + recipient(20) = 32 bytes = 64 hex
    expect(memo.length).toBe(64);
    expect(memo.startsWith(DIRECT_MINTING_PREFIX)).toBe(true);
    expect(memo.slice(16, 24)).toBe("00000000");
    expect(memo.slice(24)).toBe(RECIPIENT.slice(2));
  });

  it("round-trips encode → decode", () => {
    const memo = encodeDirectMintingMemo(RECIPIENT);
    const decoded = decodeDirectMintingMemo(memo);
    expect(decoded.recipient.toLowerCase()).toBe(RECIPIENT.toLowerCase());
  });

  it("matches the skill script's buildDirectMintingMemo output", () => {
    // Skill script: DIRECT_MINTING_PREFIX + "00000000" + recipient.slice(2).toLowerCase()
    const expected = "4642505266410018" + "00000000" + RECIPIENT.slice(2).toLowerCase();
    expect(encodeDirectMintingMemo(RECIPIENT)).toBe(expected);
  });

  it("accepts uppercase recipient (normalizes)", () => {
    const memo = encodeDirectMintingMemo("0xF5488132432118596FA13800B68DF4C0FF25131D");
    expect(decodeDirectMintingMemo(memo).recipient.toLowerCase()).toBe(RECIPIENT.toLowerCase());
  });

  it("rejects invalid addresses", () => {
    expect(() => encodeDirectMintingMemo("0x1234")).toThrow(/Invalid recipient/);
    expect(() => encodeDirectMintingMemo("not-an-address")).toThrow(/Invalid recipient/);
  });

  it("rejects wrong-length memos on decode", () => {
    expect(() => decodeDirectMintingMemo("00".repeat(31))).toThrow(/32 bytes/);
    expect(() => decodeDirectMintingMemo("00".repeat(33))).toThrow(/32 bytes/);
  });

  it("rejects wrong prefix on decode", () => {
    const bad = "0000000000000000" + "00000000" + RECIPIENT.slice(2);
    expect(() => decodeDirectMintingMemo(bad)).toThrow(/Wrong prefix/);
  });

  it("rejects non-zero padding on decode", () => {
    const bad = DIRECT_MINTING_PREFIX + "00000001" + RECIPIENT.slice(2);
    expect(() => decodeDirectMintingMemo(bad)).toThrow(/zero bytes/);
  });
});

// --- 2. DIRECT_MINTING_EX (48 bytes) ---

describe("DIRECT_MINTING_EX memo (48 bytes)", () => {
  it("matches documented format: prefix + recipient + executor", () => {
    const memo = encodeDirectMintingExMemo(RECIPIENT, EXECUTOR);
    expect(memo.length).toBe(96); // 48 bytes
    expect(memo.startsWith(DIRECT_MINTING_EX_PREFIX)).toBe(true);
    expect(memo.slice(16, 56)).toBe(RECIPIENT.slice(2));
    expect(memo.slice(56, 96)).toBe(EXECUTOR.slice(2).toLowerCase());
  });

  it("round-trips encode → decode", () => {
    const memo = encodeDirectMintingExMemo(RECIPIENT, EXECUTOR);
    const decoded = decodeDirectMintingExMemo(memo);
    expect(decoded.recipient.toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect(decoded.executor.toLowerCase()).toBe(EXECUTOR.toLowerCase());
  });

  it("rejects invalid executor", () => {
    expect(() => encodeDirectMintingExMemo(RECIPIENT, "0x1234")).toThrow(/Invalid executor/);
  });

  it("rejects wrong-length decode", () => {
    expect(() => decodeDirectMintingExMemo("00".repeat(47))).toThrow(/48 bytes/);
  });
});

// --- 3. 0xFE custom instruction (42 bytes) ---

describe("0xFE custom instruction (42 bytes)", () => {
  it("matches documented layout: op + walletId + executorFee(8) + hash(32)", () => {
    const fee = 50_000_000n; // 50 XRP in drops
    const memo = encodeFeMemo(0, fee, USEROP_HASH);
    expect(memo.length).toBe(84); // 42 bytes
    expect(memo.slice(0, 2)).toBe(OP_FE_CUSTOM);
    expect(memo.slice(2, 4)).toBe("00"); // walletId 0
    expect(hexBEToBigInt(memo.slice(4, 20), 8)).toBe(fee);
    expect(memo.slice(20)).toBe(USEROP_HASH.slice(2));
  });

  it("round-trips encode → decode", () => {
    const fee = 123_456_789n;
    const memo = encodeFeMemo(42, fee, USEROP_HASH);
    const decoded = decodeFeMemo(memo);
    expect(decoded.walletId).toBe(42);
    expect(decoded.executorFeeUBA).toBe(fee);
    expect(decoded.userOpHash.toLowerCase()).toBe(USEROP_HASH.toLowerCase());
  });

  it("handles zero fee", () => {
    const memo = encodeFeMemo(0, 0n, USEROP_HASH);
    const decoded = decodeFeMemo(memo);
    expect(decoded.executorFeeUBA).toBe(0n);
    expect(decoded.walletId).toBe(0);
  });

  it("rejects walletId out of range", () => {
    expect(() => encodeFeMemo(256, 0n, USEROP_HASH)).toThrow(/0-255/);
    expect(() => encodeFeMemo(-1, 0n, USEROP_HASH)).toThrow(/0-255/);
  });

  it("rejects bad hash length", () => {
    expect(() => encodeFeMemo(0, 0n, "0x1234")).toThrow(/32 bytes/);
  });

  it("rejects wrong-length decode", () => {
    expect(() => decodeFeMemo("00".repeat(41))).toThrow(/42 bytes/);
    expect(() => decodeFeMemo("00".repeat(43))).toThrow(/42 bytes/);
  });
});

// --- 4. 0xFF memo-field custom instruction ---

describe("0xFF memo-field custom instruction", () => {
  const userOpData = "0x" + "ab".repeat(200); // 200 bytes of dummy PackedUserOperation

  it("matches documented layout: op + walletId + executorFee(8) + userOpData", () => {
    const fee = 25_000_000n;
    const memo = encodeFfMemo(1, fee, userOpData);
    expect(memo.slice(0, 2)).toBe(OP_FF_MEMO_CUSTOM);
    expect(memo.slice(2, 4)).toBe("01");
    expect(hexBEToBigInt(memo.slice(4, 20), 8)).toBe(fee);
    expect(memo.slice(20)).toBe(userOpData.slice(2));
  });

  it("round-trips encode → decode", () => {
    const fee = 99_999_999n;
    const memo = encodeFfMemo(7, fee, userOpData);
    const decoded = decodeFfMemo(memo);
    expect(decoded.walletId).toBe(7);
    expect(decoded.executorFeeUBA).toBe(fee);
    expect(decoded.userOpData.toLowerCase()).toBe(userOpData.toLowerCase());
  });

  it("enforces the 1024-byte XRPL memo cap", () => {
    const tooBig = "0x" + "ab".repeat(XRPL_MEMO_MAX_BYTES); // exactly 1024 bytes of data + 10 header = 1034
    expect(() => encodeFfMemo(0, 0n, tooBig)).toThrow(/exceeds XRPL.*memo cap/);
  });

  it("accepts data exactly at the cap (1014 bytes payload)", () => {
    const atCap = "0x" + "ab".repeat(XRPL_MEMO_MAX_BYTES - 10); // 1014 bytes
    expect(() => encodeFfMemo(0, 0n, atCap)).not.toThrow();
  });

  it("accepts empty userOpData (header-only)", () => {
    const memo = encodeFfMemo(0, 0n, "0x");
    const decoded = decodeFfMemo(memo);
    expect(decoded.userOpData).toBe("0x");
  });

  it("rejects walletId out of range", () => {
    expect(() => encodeFfMemo(256, 0n, userOpData)).toThrow(/0-255/);
  });
});

// --- detectMemoKind dispatcher ---

describe("detectMemoKind", () => {
  it("detects DIRECT_MINTING", () => {
    expect(detectMemoKind(encodeDirectMintingMemo(RECIPIENT))).toBe("direct_minting");
  });
  it("detects DIRECT_MINTING_EX", () => {
    expect(detectMemoKind(encodeDirectMintingExMemo(RECIPIENT, EXECUTOR))).toBe("direct_minting_ex");
  });
  it("detects 0xFE", () => {
    expect(detectMemoKind(encodeFeMemo(0, 0n, USEROP_HASH))).toBe("fe_custom");
  });
  it("detects 0xFF", () => {
    expect(detectMemoKind(encodeFfMemo(0, 0n, "0xabcd"))).toBe("ff_custom");
  });
  it("returns unknown for garbage", () => {
    expect(detectMemoKind("deadbeef")).toBe("unknown");
    expect(detectMemoKind("")).toBe("unknown");
  });
});

// --- Cross-format guard: formats must not collide ---

describe("format non-collision", () => {
  it("prefixes are distinct", () => {
    expect(DIRECT_MINTING_PREFIX).not.toBe(DIRECT_MINTING_EX_PREFIX);
  });
  it("opcodes are distinct from minting prefixes", () => {
    expect(DIRECT_MINTING_PREFIX.slice(0, 2)).not.toBe(OP_FE_CUSTOM);
    expect(DIRECT_MINTING_PREFIX.slice(0, 2)).not.toBe(OP_FF_MEMO_CUSTOM);
  });
});

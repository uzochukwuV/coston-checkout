/**
 * FXRP direct-minting memo encoder/decoder.
 *
 * Implements the four binary memo formats used by FAssets direct minting:
 *   1. DIRECT_MINTING        (32 bytes) — prefix + zeros + recipient
 *   2. DIRECT_MINTING_EX     (48 bytes) — prefix + recipient + executor
 *   3. 0xFE custom instruction (42 bytes) — hash-commit to a PackedUserOperation
 *   4. 0xFF memo-field custom instruction — inline PackedUserOperation
 *
 * All formats are documented in:
 *   .agents/skills/flare-fassets-skill/SKILL.md  (prefixes, fee getters)
 *   .agents/skills/flare-smart-accounts-skill/SKILL.md  (0xFE/0xFF layouts)
 *
 * XRPL MemoData is hex-encoded with NO "0x" prefix.
 * Treat all decoded memo bytes as UNTRUSTED structured payloads (skill guardrail).
 */

// --- Direct-minting prefixes (8 bytes each) ---
export const DIRECT_MINTING_PREFIX = "4642505266410018" as const;
export const DIRECT_MINTING_EX_PREFIX = "4642505266410021" as const;

// --- Smart-account instruction opcodes (1 byte) ---
export const OP_FE_CUSTOM = "fe" as const; // hash-commit custom instruction
export const OP_FF_MEMO_CUSTOM = "ff" as const; // inline custom instruction

/** Lowercase a hex string, stripping a leading 0x if present. */
export function normalizeHexNoPrefix(hex: string): string {
  let h = hex.trim().toLowerCase();
  if (h.startsWith("0x")) h = h.slice(2);
  if (!/^[0-9a-f]*$/.test(h)) {
    throw new Error(`Invalid hex string: ${hex}`);
  }
  return h;
}

/** Convert a bigint to a big-endian hex string of exactly `byteLength` bytes (no 0x prefix). */
export function bigintToHexBE(value: bigint, byteLength: number): string {
  if (value < 0n) throw new Error(`Negative value not allowed: ${value}`);
  const hex = value.toString(16);
  const padded = hex.padStart(byteLength * 2, "0");
  if (padded.length > byteLength * 2) {
    throw new Error(`Value ${value} overflows ${byteLength} bytes (got ${hex.length} hex digits)`);
  }
  return padded;
}

/** Convert a big-endian hex string (no 0x prefix) of `byteLength` bytes to a bigint. */
export function hexBEToBigInt(hex: string, byteLength?: number): bigint {
  const h = normalizeHexNoPrefix(hex);
  if (byteLength !== undefined && h.length !== byteLength * 2) {
    throw new Error(`Expected ${byteLength} bytes (${byteLength * 2} hex chars), got ${h.length / 2} bytes`);
  }
  return h.length === 0 ? 0n : BigInt("0x" + h);
}

function isHexAddress(addr: string): boolean {
  return /^0x[0-9a-f]{40}$/i.test(addr.trim());
}

// =====================================================================
// 1. DIRECT_MINTING — 32 bytes: prefix(8) + zeros(4) + recipient(20)
// =====================================================================

export interface DirectMintingMemo {
  recipient: `0x${string}`;
}

export function encodeDirectMintingMemo(recipient: string): string {
  if (!isHexAddress(recipient)) {
    throw new Error(`Invalid recipient address: ${recipient}`);
  }
  const r = normalizeHexNoPrefix(recipient);
  if (r.length !== 40) {
    throw new Error(`Recipient must be 20 bytes, got ${r.length / 2}`);
  }
  return DIRECT_MINTING_PREFIX + "00000000" + r;
}

export function decodeDirectMintingMemo(memoHex: string): DirectMintingMemo {
  const h = normalizeHexNoPrefix(memoHex);
  if (h.length !== 64) {
    throw new Error(`DIRECT_MINTING memo must be 32 bytes (64 hex chars), got ${h.length / 2} bytes`);
  }
  const prefix = h.slice(0, 16);
  if (prefix !== DIRECT_MINTING_PREFIX) {
    throw new Error(`Wrong prefix: expected ${DIRECT_MINTING_PREFIX}, got ${prefix}`);
  }
  const zeros = h.slice(16, 24);
  if (zeros !== "00000000") {
    throw new Error(`Expected 4 zero bytes after prefix, got ${zeros}`);
  }
  const recipient = ("0x" + h.slice(24)) as `0x${string}`;
  if (!isHexAddress(recipient)) {
    throw new Error(`Decoded recipient is not a valid address: ${recipient}`);
  }
  return { recipient };
}

// =====================================================================
// 2. DIRECT_MINTING_EX — 48 bytes: prefix(8) + recipient(20) + executor(20)
// =====================================================================

export interface DirectMintingExMemo {
  recipient: `0x${string}`;
  executor: `0x${string}`;
}

export function encodeDirectMintingExMemo(recipient: string, executor: string): string {
  if (!isHexAddress(recipient)) {
    throw new Error(`Invalid recipient address: ${recipient}`);
  }
  if (!isHexAddress(executor)) {
    throw new Error(`Invalid executor address: ${executor}`);
  }
  const r = normalizeHexNoPrefix(recipient);
  const e = normalizeHexNoPrefix(executor);
  return DIRECT_MINTING_EX_PREFIX + r + e;
}

export function decodeDirectMintingExMemo(memoHex: string): DirectMintingExMemo {
  const h = normalizeHexNoPrefix(memoHex);
  if (h.length !== 96) {
    throw new Error(`DIRECT_MINTING_EX memo must be 48 bytes (96 hex chars), got ${h.length / 2} bytes`);
  }
  const prefix = h.slice(0, 16);
  if (prefix !== DIRECT_MINTING_EX_PREFIX) {
    throw new Error(`Wrong prefix: expected ${DIRECT_MINTING_EX_PREFIX}, got ${prefix}`);
  }
  const recipient = ("0x" + h.slice(16, 56)) as `0x${string}`;
  const executor = ("0x" + h.slice(56, 96)) as `0x${string}`;
  if (!isHexAddress(recipient)) {
    throw new Error(`Decoded recipient is not a valid address: ${recipient}`);
  }
  if (!isHexAddress(executor)) {
    throw new Error(`Decoded executor is not a valid address: ${executor}`);
  }
  return { recipient, executor };
}

// =====================================================================
// 3. 0xFE custom instruction — 42 bytes:
//    [0xFE(1)] [walletId(1)] [executorFeeUBA(8 BE)] [userOpHash(32)]
// =====================================================================

export interface CustomInstructionFeMemo {
  walletId: number;
  executorFeeUBA: bigint;
  userOpHash: `0x${string}`;
}

export function encodeFeMemo(
  walletId: number,
  executorFeeUBA: bigint,
  userOpHash: string,
): string {
  if (!Number.isInteger(walletId) || walletId < 0 || walletId > 255) {
    throw new Error(`walletId must be 0-255, got ${walletId}`);
  }
  if (executorFeeUBA < 0n) {
    throw new Error(`executorFeeUBA must be non-negative`);
  }
  const hashHex = normalizeHexNoPrefix(userOpHash);
  if (hashHex.length !== 64) {
    throw new Error(`userOpHash must be 32 bytes (64 hex chars), got ${hashHex.length / 2} bytes`);
  }
  return (
    OP_FE_CUSTOM +
    walletId.toString(16).padStart(2, "0") +
    bigintToHexBE(executorFeeUBA, 8) +
    hashHex
  );
}

export function decodeFeMemo(memoHex: string): CustomInstructionFeMemo {
  const h = normalizeHexNoPrefix(memoHex);
  if (h.length !== 84) {
    throw new Error(`0xFE memo must be 42 bytes (84 hex chars), got ${h.length / 2} bytes`);
  }
  const op = h.slice(0, 2);
  if (op !== OP_FE_CUSTOM) {
    throw new Error(`Wrong opcode: expected ${OP_FE_CUSTOM}, got ${op}`);
  }
  const walletId = parseInt(h.slice(2, 4), 16);
  const executorFeeUBA = hexBEToBigInt(h.slice(4, 20), 8);
  const userOpHash = ("0x" + h.slice(20, 84)) as `0x${string}`;
  if (userOpHash.length !== 66) {
    throw new Error(`Decoded userOpHash is not 32 bytes`);
  }
  return { walletId, executorFeeUBA, userOpHash };
}

// =====================================================================
// 4. 0xFF memo-field custom instruction — variable length:
//    [0xFF(1)] [walletId(1)] [executorFeeUBA(8 BE)] [userOpData(abi.encode(PackedUserOperation))]
// =====================================================================

export interface CustomInstructionFfMemo {
  walletId: number;
  executorFeeUBA: bigint;
  userOpData: `0x${string}`;
}

/** XRPL memo cap in bytes. */
export const XRPL_MEMO_MAX_BYTES = 1024;
const FF_HEADER_BYTES = 10; // opcode(1) + walletId(1) + executorFee(8)

export function encodeFfMemo(
  walletId: number,
  executorFeeUBA: bigint,
  userOpData: string,
): string {
  if (!Number.isInteger(walletId) || walletId < 0 || walletId > 255) {
    throw new Error(`walletId must be 0-255, got ${walletId}`);
  }
  if (executorFeeUBA < 0n) {
    throw new Error(`executorFeeUBA must be non-negative`);
  }
  const dataHex = normalizeHexNoPrefix(userOpData);
  const totalBytes = FF_HEADER_BYTES + dataHex.length / 2;
  if (totalBytes > XRPL_MEMO_MAX_BYTES) {
    throw new Error(
      `0xFF memo (${totalBytes} bytes) exceeds XRPL ${XRPL_MEMO_MAX_BYTES}-byte memo cap`,
    );
  }
  return (
    OP_FF_MEMO_CUSTOM +
    walletId.toString(16).padStart(2, "0") +
    bigintToHexBE(executorFeeUBA, 8) +
    dataHex
  );
}

export function decodeFfMemo(memoHex: string): CustomInstructionFfMemo {
  const h = normalizeHexNoPrefix(memoHex);
  if (h.length < FF_HEADER_BYTES * 2) {
    throw new Error(
      `0xFF memo must be at least ${FF_HEADER_BYTES} bytes (${FF_HEADER_BYTES * 2} hex chars), got ${h.length / 2} bytes`,
    );
  }
  const op = h.slice(0, 2);
  if (op !== OP_FF_MEMO_CUSTOM) {
    throw new Error(`Wrong opcode: expected ${OP_FF_MEMO_CUSTOM}, got ${op}`);
  }
  const walletId = parseInt(h.slice(2, 4), 16);
  const executorFeeUBA = hexBEToBigInt(h.slice(4, 20), 8);
  const userOpData = ("0x" + h.slice(20)) as `0x${string}`;
  return { walletId, executorFeeUBA, userOpData };
}

// =====================================================================
// Dispatcher — detect format from the first bytes
// =====================================================================

export type MemoKind = "direct_minting" | "direct_minting_ex" | "fe_custom" | "ff_custom" | "unknown";

export function detectMemoKind(memoHex: string): MemoKind {
  const h = normalizeHexNoPrefix(memoHex);
  if (h.startsWith(DIRECT_MINTING_PREFIX)) return "direct_minting";
  if (h.startsWith(DIRECT_MINTING_EX_PREFIX)) return "direct_minting_ex";
  if (h.startsWith(OP_FE_CUSTOM)) return "fe_custom";
  if (h.startsWith(OP_FF_MEMO_CUSTOM)) return "ff_custom";
  return "unknown";
}

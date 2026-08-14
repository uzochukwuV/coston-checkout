/**
 * XRPL payment utilities — build Payment transactions and deep-link URIs
 * for FAssets direct minting on Flare.
 *
 * Memo format (direct minting, 32-byte):
 *   prefix(8): 0x4642505266410018  — signals DIRECT_MINTING to the AssetManager
 *   zeros(4):  0x00000000
 *   recipient(20): Flare 0x... address (lowercase, no 0x prefix)
 * Total = 32 bytes = 64 hex chars (no 0x prefix).
 *
 * The XRPL Payment goes to the Core Vault address (AssetManager.directMintingPaymentAddress).
 * An executor later calls executeDirectMinting with an FDC proof to finalize on Flare.
 *
 * Smart-account variant (0xFE / 0xFF opcodes):
 *   0xFE = hash-commit (42-byte memo, userOp delivered off-chain by executor)
 *   0xFF = inline userOp (10-byte header + abi.encode(PackedUserOperation))
 * These are used when the recipient is a smart account that should also execute
 * a user operation (e.g. deposit into a vault) atomically with the mint.
 */

export interface XrplPaymentParams {
  destination: string;
  amountDrops: string;
  destinationTag?: number;
  memoHex?: string;
}

/** Coston2 / testnet Core Vault address — resolved live from AssetManager on the backend. */
export const TESTNET_CORE_VAULT = "rDhpmiPq4BVBDWMVdSrmkgt8thKyRzGV1p";

/** Direct-minting memo prefix (8 bytes) — signals DIRECT_MINTING. */
const DIRECT_MINTING_PREFIX = "4642505266410018";

/**
 * Build the 32-byte direct-minting memo hex for a Flow A order.
 * Format: prefix(8) + zeros(4) + recipient(20) = 32 bytes.
 * @param recipient Flare address (0x...) that will receive the minted FXRP
 * @returns 64-char hex string (no 0x prefix), or undefined if address is invalid
 */
export function buildDirectMintingMemo(recipient: string): string | undefined {
  const addr = recipient.replace(/^0x/, "").toLowerCase();
  if (addr.length !== 40 || !/^[0-9a-f]+$/.test(addr)) return undefined;
  return DIRECT_MINTING_PREFIX + "00000000" + addr;
}

/**
 * Build an XRPL Payment transaction object for direct minting.
 * This is the raw transaction — Crossmark handles autofill (Sequence, Fee, etc.).
 */
export function buildDirectMintingPayment(params: {
  destination: string;
  xrpAmountDrops: string;
  recipientFlareAddress: string;
  destinationTag?: number;
}): Record<string, unknown> {
  const memoHex = buildDirectMintingMemo(params.recipientFlareAddress);
  if (!memoHex) throw new Error(`Invalid recipient Flare address: ${params.recipientFlareAddress}`);

  const tx: Record<string, unknown> = {
    TransactionType: "Payment",
    Destination: params.destination,
    Amount: params.xrpAmountDrops,
    Memos: [{ Memo: { MemoData: memoHex } }],
  };
  if (params.destinationTag !== undefined) {
    tx.DestinationTag = params.destinationTag;
  }
  return tx;
}

export function buildXrplPaymentUri(params: XrplPaymentParams): string {
  const search = new URLSearchParams();
  search.set("to", params.destination);
  search.set("amount", (Number(params.amountDrops) / 1_000_000).toString());
  if (params.destinationTag) search.set("dt", params.destinationTag.toString());
  if (params.memoHex) search.set("memo", params.memoHex);
  return `https://xrpl.services/send/xrp?${search.toString()}`;
}

export function buildXrplPaymentJson(params: XrplPaymentParams): object {
  const payment: Record<string, unknown> = {
    TransactionType: "Payment",
    Destination: params.destination,
    Amount: params.amountDrops,
  };
  if (params.destinationTag) payment.DestinationTag = params.destinationTag;
  if (params.memoHex) {
    payment.Memos = [
      {
        Memo: {
          MemoType: "text/plain",
          MemoData: params.memoHex,
          MemoFormat: "hex",
        },
      },
    ];
  }
  return payment;
}

/** Convert a human XRP amount (e.g. "10.5") to drops string (1 XRP = 1,000,000 drops). */
export function xrpToDropsStr(xrp: string | number): string {
  const s = typeof xrp === "number" ? xrp.toFixed(6) : xrp;
  // Parse as decimal and convert to integer drops without floating-point error.
  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  const drops = BigInt(whole) * 1_000_000n + BigInt(fracPadded || "0");
  return drops.toString();
}

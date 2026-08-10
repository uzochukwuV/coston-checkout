/**
 * Payment matcher — match an observed XRPL Core Vault payment to an open order.
 *
 * Pure logic. Security-critical: this is the FIRST filter on UNTRUSTED XRPL data.
 * A match here only means "candidate"; settlement requires the FDC XRPPayment proof
 * to confirm on-chain (status, amount, tag) before executeDirectMinting. The raw
 * XRPL memo/amount are never trusted for business decisions on their own.
 *
 * Binding strategy: destination tag (MintingTagManager). The 32-byte memo has no
 * room for an orderId, so the tag IS the order id for Flow A.
 */

import type { VaultPayment } from "../chain/xrpl-watcher.js";
import type { Order } from "./order.js";
import { isQuoteLive } from "./order.js";

export interface MatchResult {
  matched: boolean;
  order?: Order;
  reason?: string;
}

/**
 * Match a vault payment to one of the open orders.
 * Rules:
 *   - order.status must be AWAITING_PAYMENT
 *   - payment.destinationTag must equal order.tagId
 *   - payment amount >= order.quote.minAcceptedDrops (merchant not underpaid)
 *   - order quote not expired
 *   - (optional) expectedVaultAddress matches the payment destination
 */
export function matchPaymentToOrder(
  payment: VaultPayment,
  orders: Order[],
  nowSec = Math.floor(Date.now() / 1000),
): MatchResult {
  if (payment.destinationTag === undefined) {
    return { matched: false, reason: "payment has no destination tag" };
  }
  const order = orders.find(
    (o) => o.status === "AWAITING_PAYMENT" && o.tagId === payment.destinationTag,
  );
  if (!order) {
    return { matched: false, reason: `no open order for tag ${payment.destinationTag}` };
  }
  if (!isQuoteLive(order.quote, nowSec)) {
    return { matched: false, reason: `order ${order.id} expired`, order };
  }
  const paidDrops = BigInt(payment.amountDrops || "0");
  if (paidDrops < order.quote.minAcceptedDrops) {
    return {
      matched: false,
      reason: `underpaid: ${paidDrops} < min ${order.quote.minAcceptedDrops} drops`,
      order,
    };
  }
  return { matched: true, order };
}

/** Overpayment policy: credit the full amount to the merchant (mint all paid XRP). */
export function isOverpayment(payment: VaultPayment, order: Order): boolean {
  return BigInt(payment.amountDrops || "0") > order.quote.xrpAmountDrops;
}

/**
 * Flow C matcher — bind a vault payment to a Flow C (AUTO) order by the 0xFE memo
 * user-op hash. The customer's XRPL Payment carries a 42-byte `0xFE` memo whose
 * last 32 bytes are `keccak256(PackedUserOperation)`; the order stores the same
 * hash (from createOrder). No destination tag is used (tags would credit the
 * tag-holder, not the smart account).
 *
 * Pure. Security: the memo hash is a commitment only — settlement still requires
 * the on-chain `executeDirectMintingWithData` hash check (the trust root). The raw
 * memo is decoded strictly per the 0xFE binary format; never treated as text.
 */
export function matchPaymentToFlowCOrder(
  payment: VaultPayment,
  orders: Order[],
  nowSec = Math.floor(Date.now() / 1000),
): MatchResult {
  if (!payment.memoData) {
    return { matched: false, reason: "Flow C payment has no memo" };
  }
  // extract the 32-byte userOpHash from the 42-byte 0xFE memo (bytes 10-41)
  let userOpHash: `0x${string}`;
  try {
    userOpHash = decodeFeMemoUserOpHash(payment.memoData);
  } catch (e) {
    return { matched: false, reason: `memo is not a valid 0xFE instruction: ${(e as Error).message}` };
  }
  const order = orders.find(
    (o) => o.status === "AWAITING_PAYMENT" && o.settlement === "AUTO" && o.userOpHash === userOpHash,
  );
  if (!order) {
    return { matched: false, reason: `no open Flow C order for userOpHash ${userOpHash}` };
  }
  if (!isQuoteLive(order.quote, nowSec)) {
    return { matched: false, reason: `order ${order.id} expired`, order };
  }
  const paidDrops = BigInt(payment.amountDrops || "0");
  if (paidDrops < order.quote.minAcceptedDrops) {
    return {
      matched: false,
      reason: `underpaid: ${paidDrops} < min ${order.quote.minAcceptedDrops} drops`,
      order,
    };
  }
  // record the customer's XRPL address (the smart-account owner) from the payment source
  return { matched: true, order: { ...order, customerXrplAddress: payment.sourceAddress } };
}

/** Decode the 32-byte userOpHash from a 42-byte 0xFE memo (hex, no 0x prefix). */
function decodeFeMemoUserOpHash(memoHex: string): `0x${string}` {
  const h = memoHex.startsWith("0x") ? memoHex.slice(2).toLowerCase() : memoHex.toLowerCase();
  if (h.length !== 84) {
    throw new Error(`0xFE memo must be 42 bytes (84 hex chars), got ${h.length / 2} bytes`);
  }
  if (h.slice(0, 2) !== "fe") {
    throw new Error(`expected 0xFE memo opcode, got 0x${h.slice(0, 2)}`);
  }
  return ("0x" + h.slice(20, 84)) as `0x${string}`;
}

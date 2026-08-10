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

/**
 * Refund + retry policy — pure decisions for edge cases.
 *
 * Determines what action to take given an order's payment/settlement state:
 *   - OVERPAID        → CREDIT (mint all; merchant gets more — no refund)
 *   - UNDERPAID       → REJECT  (order FAILED; customer recovers via FAssets
 *                                Core Vault recovery flow, out of our scope)
 *   - REDEEM_DEFAULT  → RETRY if attempts < max; else REFUND the customer
 *   - REDUNDANT/other → NO_ACTION
 *
 * Pure logic — no network. Unit-tested independently.
 */

import type { Order } from "./order.js";

export type RefundAction = "CREDIT" | "REJECT" | "RETRY" | "REFUND" | "NO_ACTION";

export interface PolicyInput {
  order: Order;
  paidDrops: bigint;
  maxRedeemAttempts: number;
}

export interface PolicyResult {
  action: RefundAction;
  reason: string;
}

/** Decide the action for an order given what the customer paid. */
export function decideRefundPolicy(input: PolicyInput): PolicyResult {
  const { order, paidDrops, maxRedeemAttempts } = input;

  if (order.status === "REDEEM_DEFAULTED") {
    const attempts = order.redeemAttempts ?? 0;
    if (attempts < maxRedeemAttempts) {
      return { action: "RETRY", reason: `agent default; retry ${attempts + 1}/${maxRedeemAttempts}` };
    }
    return { action: "REFUND", reason: `agent default after ${attempts} attempts; refund customer` };
  }

  if (order.status === "AWAITING_PAYMENT" || order.status === "PAYMENT_DETECTED") {
    if (paidDrops < order.quote.minAcceptedDrops) {
      return {
        action: "REJECT",
        reason: `underpaid ${paidDrops} < min ${order.quote.minAcceptedDrops}; customer recovers via Core Vault`,
      };
    }
    if (paidDrops > order.quote.xrpAmountDrops) {
      return { action: "CREDIT", reason: `overpaid; credit full amount to merchant` };
    }
  }

  return { action: "NO_ACTION", reason: "no policy action required" };
}

/**
 * Refund accounting: the operator refunds the customer's XRP minus fees already
 * paid (mint fee is non-recoverable once minted). The operator covers the
 * redemption default loss as a cost of doing business (insurance).
 *
 * Returns the amount the operator should send back to the customer (drops).
 * Pure — does not perform the refund.
 */
export function computeRefundAmount(
  customerPaidDrops: bigint,
  mintFeeDrops: bigint,
  operatorFeeDrops: bigint,
): bigint {
  // refund what's recoverable: customer payment minus sunk mint fee.
  // the operator waives its own fee on a refund.
  const sunk = mintFeeDrops + operatorFeeDrops;
  return customerPaidDrops > sunk ? customerPaidDrops - sunk : 0n;
}

/**
 * Shared types — mirror the backend Order/Quote interfaces.
 * Kept in sync manually (no codegen); the backend serializes BigInt as string.
 */

export type OrderStatus =
  | "CREATED"
  | "AWAITING_PAYMENT"
  | "PAYMENT_DETECTED"
  | "SETTLING"
  | "SETTLED"
  | "MINTED"
  | "REDEEMING"
  | "REDEEMED"
  | "REDEEM_DEFAULTED"
  | "REFUNDED"
  | "EXPIRED"
  | "FAILED";

export type SettlementMode = "FXRP" | "XRP" | "AUTO";

export interface FeeBreakdown {
  customerXrpDrops: string;
  mintFeeDrops: string;
  fxrpMintedDrops: string;
  redeemFeeDrops: string;
  operatorFeeDrops: string;
  merchantFxrpDrops: string;
  merchantXrpDrops: string;
}

export interface OrderQuote {
  usdAmount: number;
  xrpUsdPrice: number;
  xrpUsdDecimals: number;
  xrpAmountDrops: string;
  minAcceptedDrops: string;
  slippageBps: number;
  serviceFeeBps: number;
  expiresAt: number;
  createdAt: number;
}

export interface Order {
  id: string;
  merchantFlareAddress: string;
  merchantId: string;
  settlement: SettlementMode;
  tagId?: number;
  quote: OrderQuote;
  status: OrderStatus;
  matchedTxHash?: string;
  settleTxHash?: string;
  merchantXrplAddress?: string;
  merchantXrplDestinationTag?: number;
  redemptionRequestId?: string;
  redeemTxHash?: string;
  redemptionPaymentTxHash?: string;
  redeemAttempts?: number;
  refundTxHash?: string;
  feeBreakdown?: FeeBreakdown;
  error?: string;
  createdAt: number;
}

export interface CreateOrderRequest {
  usdAmount: number;
}

/** Phase markers for the status progress bar. */
export const FLOW_STEPS: { status: OrderStatus; label: string }[] = [
  { status: "AWAITING_PAYMENT", label: "Awaiting XRP Payment" },
  { status: "PAYMENT_DETECTED", label: "Payment Detected" },
  { status: "SETTLING", label: "Minting FXRP" },
  { status: "SETTLED", label: "FXRP Minted" },
];

export function statusStepIndex(status: OrderStatus): number {
  const idx = FLOW_STEPS.findIndex((s) => s.status === status);
  if (idx >= 0) return idx;
  // terminal / non-flow states
  if (status === "MINTED" || status === "REDEEMING" || status === "REDEEMED") return 3;
  if (status === "EXPIRED" || status === "FAILED" || status === "REFUNDED") return -1;
  return 0;
}

export function isTerminal(status: OrderStatus): boolean {
  return (
    status === "SETTLED" ||
    status === "REDEEMED" ||
    status === "EXPIRED" ||
    status === "FAILED" ||
    status === "REFUNDED"
  );
}

/** Convert drops (1 XRP = 1e6 drops) to a human display string. */
export function dropsToXrp(drops: string | bigint): string {
  const n = typeof drops === "bigint" ? drops : BigInt(drops);
  return (Number(n) / 1_000_000).toFixed(6).replace(/\.?0+$/, "");
}

/** Format drops as a compact XRP amount (e.g. "1.0 XRP"). */
export function formatXrp(drops: string | bigint): string {
  return `${dropsToXrp(drops)} XRP`;
}

/**
 * Checkout order model + pricing + state machine.
 *
 * Pure logic — no network. Unit-tested independently.
 *
 * Flow A (settle-to-FXRP):
 *   CREATED → AWAITING_PAYMENT → PAYMENT_DETECTED → SETTLING → SETTLED
 *   CREATED → EXPIRED / FAILED
 *
 * Flow B (settle-to-XRP via redeemWithTag):
 *   ... → SETTLING → MINTED → REDEEMING → REDEEMED
 *   REDEEMING → REDEEM_DEFAULTED → (REDEEMING retry | REFUNDED | FAILED)
 *
 * Flow C (atomic mint + user op via executeDirectMintingWithData):
 *   ... → SETTLING → SETTLED  (atomic: mint + user op succeed together)
 *   ... → SETTLING → FAILED   (any revert rolls back the mint; XRP stays at
 *                              the Core Vault, recoverable via the 0xE0 skip-memo)
 *
 * Pricing: quote USD → XRP amount (drops) via FTSO feed, with a slippage buffer
 * and a checkout service fee (BIPS). Both are added on top of the USD-equivalent
 * XRP so the merchant is not shorted by volatility or fees.
 */

import { FtsoClient, type FeedResult } from "../chain/ftso.js";

export type OrderStatus =
  | "CREATED"
  | "AWAITING_PAYMENT"
  | "PAYMENT_DETECTED"
  | "SETTLING"
  | "SETTLED" // Flow A terminal: FXRP minted to merchant
  | "MINTED" // Flow B: FXRP minted to operator, pending redemption
  | "REDEEMING" // redeemWithTag submitted, awaiting agent XRP payout
  | "REDEEMED" // Flow B terminal: XRP paid to merchant XRPL address
  | "REDEEM_DEFAULTED" // agent missed payout deadline; retry or refund
  | "REFUNDED" // operator refunded the customer (XRP)
  | "EXPIRED"
  | "FAILED";

export type SettlementMode = "FXRP" | "XRP" | "AUTO";

/**
 * Flow C action spec — describes the atomic post-mint user operation.
 * The operator encodes this into a PackedUserOperation; the customer commits to
 * its hash in the 0xFE memo. Atomicity: if the user op reverts, no FXRP is minted.
 */
export type ActionKind = "transfer" | "deposit" | "swap" | "raw";

export interface OrderAction {
  kind: ActionKind;
  /** For "transfer"/"swap": the FXRP token address (passed to the builder). */
  fxrpTokenAddress?: `0x${string}`;
  /** For "transfer": recipient EOA (merchant's Flare address). */
  recipient?: `0x${string}`;
  /** For "deposit"/"swap": the target contract (vault / DEX). */
  targetAddress?: `0x${string}`;
  /** For "deposit": the vault function selector (default "deposit"). */
  depositSelector?: string;
  /** For "raw": pre-encoded calldata for a single contract call. */
  rawCallData?: `0x${string}`;
  /** For "raw": FLR value (wei) to attach to the call. */
  rawValueWei?: bigint;
  /** Amount of FXRP the action operates on (drops/UBA). Defaults to the full mint. */
  amountDrops?: bigint;
}

/**
 * Fee breakdown for an order (all in XRP drops = UBA for FXRP).
 * Set by the pricing module when the order is created/priced.
 */
export interface FeeBreakdown {
  customerXrpDrops: bigint; // what the customer sends
  mintFeeDrops: bigint; // deducted at mint (feeBIPS % + min floor + executor fee)
  /** Total FXRP minted (to merchant in Flow A, to operator in Flow B). */
  fxrpMintedDrops: bigint;
  redeemFeeDrops: bigint; // deducted at redeem (Flow B only; 0 for Flow A)
  operatorFeeDrops: bigint; // checkout service fee (operator revenue)
  merchantFxrpDrops: bigint; // Flow A: FXRP the merchant receives (= fxrpMinted)
  merchantXrpDrops: bigint; // Flow B: XRP the merchant receives after all fees
}

export interface OrderQuote {
  usdAmount: number;
  xrpUsdPrice: number; // display price at quote time
  xrpUsdDecimals: number;
  /** XRP the customer must send, in drops (1 XRP = 1e6 drops). */
  xrpAmountDrops: bigint;
  /** Minimum accepted amount (drops); below this the merchant is underpaid. */
  minAcceptedDrops: bigint;
  slippageBps: number; // e.g. 100 = 1%
  serviceFeeBps: number; // e.g. 50 = 0.5%
  expiresAt: number; // unix seconds
  createdAt: number;
}

export interface Order {
  id: string;
  merchantFlareAddress: `0x${string}`;
  merchantId: string;
  settlement: SettlementMode;
  /** MintingTagManager tag assigned to this order (order binding). */
  tagId?: number;
  quote: OrderQuote;
  status: OrderStatus;
  /** XRPL tx hash once a matching payment is detected. */
  matchedTxHash?: string;
  /** Flare tx hash once executeDirectMinting confirms. */
  settleTxHash?: string;
  /** For Flow B: merchant XRPL payout address (r-address) + destination tag. */
  merchantXrplAddress?: string;
  merchantXrplDestinationTag?: number;
  /** For Flow B: redemption request id from RedemptionWithTagRequested. */
  redemptionRequestId?: bigint;
  /** For Flow B: Flare tx hash of the redeemWithTag call. */
  redeemTxHash?: string;
  /** For Flow B: XRPL tx hash of the agent's payout (once confirmed). */
  redemptionPaymentTxHash?: string;
  /** Number of redemption attempts (for retry policy). */
  redeemAttempts?: number;
  /** Refund tx hash if the customer was refunded. */
  refundTxHash?: string;
  /** Computed fee breakdown (set when the order is priced). */
  feeBreakdown?: FeeBreakdown;
  /** For Flow C: the atomic post-mint action spec. */
  action?: OrderAction;
  /** For Flow C: the customer's XRPL address (maps to their smart account). */
  customerXrplAddress?: string;
  /** For Flow C: the personal account address (smart account) for this XRPL addr. */
  personalAccountAddress?: `0x${string}`;
  /** For Flow C: the 0xFE memo user-op hash the customer committed to. */
  userOpHash?: `0x${string}`;
  /** For Flow C: the current memo nonce used to build the user op. */
  userOpNonce?: bigint;
  /** Error message on FAILED. */
  error?: string;
  createdAt: number;
}

export interface QuoteParams {
  usdAmount: number;
  xrpUsd: FeedResult;
  slippageBps?: number; // default 100 (1%)
  serviceFeeBps?: number; // default 50 (0.5%)
  expirySeconds?: number; // default 900 (15 min)
}

/** Compute a quote: USD → required XRP (drops) with slippage + service fee. */
export function computeQuote(params: QuoteParams): OrderQuote {
  const { usdAmount, xrpUsd } = params;
  const slippageBps = params.slippageBps ?? 100;
  const serviceFeeBps = params.serviceFeeBps ?? 50;
  const expirySeconds = params.expirySeconds ?? 900;
  const createdAt = Math.floor(Date.now() / 1000);

  if (usdAmount <= 0) throw new Error("usdAmount must be positive");
  if (xrpUsd.value <= 0n) throw new Error("FTSO price must be positive");
  if (xrpUsd.stale) throw new Error("FTSO price is stale — refuse to quote");

  // base XRP drops for the USD amount (no fee/slippage yet)
  const baseDrops = FtsoClient.xrpAmountDrops(usdAmount, xrpUsd);

  // apply service fee (added on top, merchant keeps the full USD-equiv)
  const withFee = (baseDrops * 10_000n) / BigInt(10_000 - serviceFeeBps);
  // apply slippage buffer (customer pays a bit more so re-quote isn't needed on small moves)
  const xrpAmountDrops = (withFee * BigInt(10_000 + slippageBps)) / 10_000n;

  // minimum accepted = base (USD-equiv) — anything below underpays the merchant
  const minAcceptedDrops = baseDrops;

  return {
    usdAmount,
    xrpUsdPrice: FtsoClient.toDisplayPrice(xrpUsd),
    xrpUsdDecimals: xrpUsd.decimals,
    xrpAmountDrops,
    minAcceptedDrops,
    slippageBps,
    serviceFeeBps,
    expiresAt: createdAt + expirySeconds,
    createdAt,
  };
}

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  CREATED: ["AWAITING_PAYMENT", "EXPIRED", "FAILED"],
  AWAITING_PAYMENT: ["PAYMENT_DETECTED", "EXPIRED", "FAILED"],
  PAYMENT_DETECTED: ["SETTLING", "FAILED"],
  SETTLING: ["SETTLED", "MINTED", "FAILED"],
  SETTLED: [],
  MINTED: ["REDEEMING", "FAILED"],
  REDEEMING: ["REDEEMED", "REDEEM_DEFAULTED", "FAILED"],
  REDEEMED: [],
  REDEEM_DEFAULTED: ["REDEEMING", "REFUNDED", "FAILED"],
  REFUNDED: [],
  EXPIRED: [],
  FAILED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transition(order: Order, to: OrderStatus, patch?: Partial<Order>): Order {
  if (!canTransition(order.status, to)) {
    throw new Error(`Invalid transition ${order.status} → ${to} for order ${order.id}`);
  }
  return { ...order, ...patch, status: to };
}

/** Is the quote still live (not expired)? */
export function isQuoteLive(quote: OrderQuote, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return nowSec < quote.expiresAt;
}

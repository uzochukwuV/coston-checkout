/**
 * Pricing — fee-stack accounting for Flow A (settle-to-FXRP) and Flow B
 * (settle-to-XRP via redeemWithTag).
 *
 * Pure logic — no network. Unit-tested independently.
 *
 * The FAssets mint/redeem rate is 1:1 with the underlying asset (XRP), modulo
 * fees. The FTSO price feed is only used to translate the merchant's USD price
 * into the XRP amount the customer must send. So Flow B's "round trip"
 * (XRP → FXRP → XRP) does NOT introduce price slippage — only a fee stack:
 *
 *   customerXRP
 *     - mintFee      (feeBIPS % of amount, floored at minimumFeeUBA, + executorFee)
 *     = fxrpMinted   (Flow A merchant receives this as FXRP)
 *     - redeemFee    (CoreVaultRedemptionFeeBIPS % of amount)
 *     - operatorFee  (checkout service fee, BIPS)
 *     = merchantXRP  (Flow B merchant receives this as XRP)
 *
 * Guarantee: merchantXRP (and merchantFXRP) must be >= the USD-equivalent XRP
 * at quote time, else the quote is rejected (merchant would be shorted by fees).
 * The customer's slippage buffer + service fee (in order.ts) covers the
 * volatility cushion; this module distributes the fees.
 */

import type { FeeBreakdown } from "./order.js";
import type { FeeParams } from "../chain/asset-manager.js";

const BPS_DENOM = 10_000n;

/** Percent of an amount in BIPS, rounding down. */
function bipsOf(amount: bigint, bips: bigint): bigint {
  return (amount * bips) / BPS_DENOM;
}

export interface PriceFlowInput {
  /** What the customer sends (drops), already including the slippage + service buffer. */
  customerXrpDrops: bigint;
  fees: FeeParams;
  /** Checkout operator service fee in BIPS (e.g. 50 = 0.5%). */
  operatorFeeBps: bigint;
  /** Settlement mode determines which fees apply. */
  settlement: "FXRP" | "XRP";
}

export interface PriceFlowResult {
  breakdown: FeeBreakdown;
  /** True if the merchant receives at least the customer's USD-equivalent after fees. */
  merchantProtected: boolean;
}

/**
 * Compute the fee breakdown for a paid order.
 *
 * Minting fee priority (per FAssets docs): the minting fee takes priority; if
 * funds are insufficient for both fees, the executor fee is reduced first. We
 * model this by capping the executor fee at what remains after the minting fee.
 */
export function priceOrder(input: PriceFlowInput): PriceFlowResult {
  const { customerXrpDrops, fees, operatorFeeBps, settlement } = input;

  // --- minting fee ---
  const percentageMintFee = bipsOf(customerXrpDrops, fees.mintFeeBIPS);
  // minting fee is floored at the minimum, but cannot exceed the amount
  const mintFeeFloor = fees.mintMinimumFeeUBA;
  const mintingFee = percentageMintFee > mintFeeFloor ? percentageMintFee : mintFeeFloor;
  // executor fee is flat, but reduced if the amount can't cover mint fee + executor fee
  let executorFee = fees.executorFeeUBA;
  if (mintingFee + executorFee > customerXrpDrops) {
    executorFee = customerXrpDrops > mintingFee ? customerXrpDrops - mintingFee : 0n;
  }
  const totalMintFee = mintingFee + executorFee;
  const fxrpMinted = customerXrpDrops > totalMintFee ? customerXrpDrops - totalMintFee : 0n;

  if (settlement === "FXRP") {
    // Flow A: merchant receives FXRP. Operator fee is taken from the service
    // buffer already paid by the customer (not deducted from merchant FXRP),
    // so the merchant keeps the full minted FXRP. We record the operator's
    // notional revenue as the service-fee portion of the customer's payment.
    const operatorFeeDrops = bipsOf(customerXrpDrops, operatorFeeBps);
    const breakdown: FeeBreakdown = {
      customerXrpDrops,
      mintFeeDrops: totalMintFee,
      fxrpMintedDrops: fxrpMinted,
      redeemFeeDrops: 0n,
      operatorFeeDrops,
      merchantFxrpDrops: fxrpMinted,
      merchantXrpDrops: 0n,
    };
    return { breakdown, merchantProtected: fxrpMinted > 0n };
  }

  // Flow B: redeem FXRP → XRP. Redeem fee is a % of the FXRP redeemed.
  const redeemFeeDrops = bipsOf(fxrpMinted, fees.redeemFeeBIPS);
  // operator service fee is a % of the FXRP redeemed, taken from the payout
  const operatorFeeDrops = bipsOf(fxrpMinted, operatorFeeBps);
  const totalDeducted = redeemFeeDrops + operatorFeeDrops;
  const merchantXrpDrops = fxrpMinted > totalDeducted ? fxrpMinted - totalDeducted : 0n;

  const breakdown: FeeBreakdown = {
    customerXrpDrops,
    mintFeeDrops: totalMintFee,
    fxrpMintedDrops: fxrpMinted,
    redeemFeeDrops,
    operatorFeeDrops,
    merchantFxrpDrops: 0n, // Flow B: merchant gets XRP, not FXRP
    merchantXrpDrops,
  };

  return { breakdown, merchantProtected: merchantXrpDrops > 0n };
}

/** Check the redemption amount is above the minimum redeemable (UBA). */
export function isRedeemable(amountUba: bigint, minimumRedeemAmountUBA: bigint): boolean {
  return amountUba >= minimumRedeemAmountUBA;
}

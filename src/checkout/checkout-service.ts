/**
 * Checkout service — orchestrates order creation, tag allocation, payment
 * matching, executor dispatch, and merchant webhook delivery.
 *
 * This is the glue layer over the pure logic (order/matcher/webhook/tag-pool)
 * and the chain clients (ftso/xrpl-watcher/fdc/executor).
 */

import type { AssetManagerClient, FeeParams } from "../chain/asset-manager.js";
import { FtsoClient, XRP_USD_FEED_ID } from "../chain/ftso.js";
import type { XrplWatcher } from "../chain/xrpl-watcher.js";
import type { VaultPayment } from "../chain/xrpl-watcher.js";
import {
  computeQuote,
  isQuoteLive,
  transition,
  type Order,
  type QuoteParams,
  type SettlementMode,
  type FeeBreakdown,
} from "./order.js";
import { OrderStore } from "./order-store.js";
import { TagPool } from "./tag-pool.js";
import { matchPaymentToOrder } from "./matcher.js";
import { signWebhook, deliverWebhook, type SignedWebhook } from "./webhook.js";
import type { Executor } from "./executor.js";
import type { Redeemer } from "./redeemer.js";
import { priceOrder } from "./pricing.js";
import { decideRefundPolicy, computeRefundAmount } from "./refund.js";

export interface CheckoutConfig {
  merchantId: string;
  merchantFlareAddress: `0x${string}`;
  /** For Flow B: merchant XRPL payout address + optional destination tag. */
  merchantXrplAddress?: string;
  merchantXrplDestinationTag?: number;
  webhookUrl?: string;
  webhookSecret: string;
  slippageBps?: number;
  serviceFeeBps?: number; // operator service fee in BIPS
  expirySeconds?: number;
  maxRedeemAttempts?: number; // default 3
}

export interface CreateOrderInput {
  usdAmount: number;
  settlement?: SettlementMode; // default "FXRP"
}

export class CheckoutService {
  private store = new OrderStore();
  private tagPool = new TagPool();
  private idCounter = 0;
  private fees: FeeParams | undefined;

  constructor(
    private cfg: CheckoutConfig,
    private ftso: FtsoClient,
    private watcher: XrplWatcher,
    private executor: Executor,
    private assetManager: AssetManagerClient,
    private redeemer?: Redeemer,
  ) {}

  /** Load + cache live fee params (mint + redeem). */
  async loadFees(): Promise<FeeParams> {
    if (!this.fees) this.fees = await this.assetManager.getFeeParams();
    return this.fees;
  }

  /** Create a new order: quote via FTSO, allocate a tag, price fees, store. */
  async createOrder(input: CreateOrderInput): Promise<Order> {
    const settlement: SettlementMode = input.settlement ?? "FXRP";
    if (settlement === "XRP" && !this.cfg.merchantXrplAddress) {
      throw new Error("Flow B (XRP settlement) requires merchantXrplAddress in config");
    }
    if (settlement === "XRP" && !this.redeemer) {
      throw new Error("Flow B (XRP settlement) requires a Redeemer");
    }

    const xrpUsd = await this.ftso.getFeed(XRP_USD_FEED_ID);
    const quote = computeQuote({
      usdAmount: input.usdAmount,
      xrpUsd,
      slippageBps: this.cfg.slippageBps,
      serviceFeeBps: this.cfg.serviceFeeBps,
      expirySeconds: this.cfg.expirySeconds,
    });
    const id = `ord_${(++this.idCounter).toString(36).padStart(6, "0")}`;
    let order: Order = {
      id,
      merchantFlareAddress: this.cfg.merchantFlareAddress,
      merchantId: this.cfg.merchantId,
      settlement,
      quote,
      status: "CREATED",
      createdAt: Math.floor(Date.now() / 1000),
      merchantXrplAddress: settlement === "XRP" ? this.cfg.merchantXrplAddress : undefined,
      merchantXrplDestinationTag: settlement === "XRP" ? this.cfg.merchantXrplDestinationTag : undefined,
    };

    // price the fee stack (uses live fee params)
    const fees = await this.loadFees();
    const { breakdown } = priceOrder({
      customerXrpDrops: quote.xrpAmountDrops,
      fees,
      operatorFeeBps: BigInt(this.cfg.serviceFeeBps ?? 50),
      settlement,
    });
    order = { ...order, feeBreakdown: breakdown };

    // allocate a tag (order binding)
    if (this.tagPool.totalCount() > 0) {
      const tagId = this.tagPool.allocate(id, this.cfg.merchantFlareAddress);
      order = { ...order, tagId };
    }
    order = transition(order, "AWAITING_PAYMENT");
    this.store.save(order);
    return order;
  }

  getOrder(id: string): Order | undefined {
    return this.store.get(id);
  }

  listOpen(): Order[] {
    return this.store.listOpen("AWAITING_PAYMENT");
  }

  getVaultAddress(): Promise<string> {
    return this.assetManager.getDirectMintingParams().then((p) => p.coreVaultXrplAddress);
  }

  /** Process a batch of recent vault payments from the watcher. */
  async pollAndMatch(): Promise<Order[]> {
    const params = await this.assetManager.getDirectMintingParams();
    const payments = await this.watcher.getRecentVaultPayments(params.coreVaultXrplAddress);
    const open = this.store.listOpen("AWAITING_PAYMENT");
    const settled: Order[] = [];
    for (const payment of payments) {
      const result = matchPaymentToOrder(payment, open);
      if (!result.matched || !result.order) continue;
      let order = transition(result.order, "PAYMENT_DETECTED", {
        matchedTxHash: payment.txHash,
      });
      this.store.save(order);
      order = await this.settleOrder(order);
      if (order.status === "SETTLED" || order.status === "REDEEMED") {
        settled.push(order);
      }
    }
    return settled;
  }

  /** Process a single matched payment (for tests / explicit dispatch). */
  async processPayment(payment: VaultPayment): Promise<Order | undefined> {
    const open = this.store.listOpen("AWAITING_PAYMENT");
    const result = matchPaymentToOrder(payment, open);
    if (!result.matched || !result.order) return undefined;
    let order = transition(result.order, "PAYMENT_DETECTED", {
      matchedTxHash: payment.txHash,
    });
    this.store.save(order);
    return this.settleOrder(order);
  }

  /**
   * Settle a detected order: mint FXRP, then (Flow B) redeem to XRP.
   * Shared by pollAndMatch + processPayment.
   */
  private async settleOrder(order: Order): Promise<Order> {
    let current = transition(order, "SETTLING");
    this.store.save(current);

    // 1. mint FXRP via the executor (FDC proof → executeDirectMinting)
    const execResult = await this.executor.settle(current.matchedTxHash!, true);
    if (!execResult.ok || !execResult.flareTxHash) {
      if (!execResult.dryRun) {
        current = transition(current, "FAILED", { error: execResult.error });
        this.store.save(current);
        await this.fireWebhook(current, "");
      }
      // dry-run: leave in SETTLING
      return this.store.get(current.id)!;
    }

    if (current.settlement === "FXRP") {
      // Flow A: done — FXRP minted to merchant
      current = transition(current, "SETTLED", {
        settleTxHash: execResult.flareTxHash,
      });
      this.store.save(current);
      await this.fireWebhook(current, execResult.flareTxHash);
      return current;
    }

    // Flow B: FXRP minted to operator; now redeem to XRP
    current = transition(current, "MINTED", { settleTxHash: execResult.flareTxHash });
    this.store.save(current);
    return this.redeemOrder(current);
  }

  /** Flow B: redeem minted FXRP to the merchant's XRPL address. */
  private async redeemOrder(order: Order): Promise<Order> {
    if (!this.redeemer || order.settlement !== "XRP") return order;
    const fees = await this.loadFees();
    const redeemAmount = order.feeBreakdown?.fxrpMintedDrops ?? 0n;
    if (redeemAmount <= 0n) {
      const failed = transition(order, "FAILED", { error: "nothing to redeem" });
      this.store.save(failed);
      return failed;
    }
    // enter REDEEMING (valid from MINTED or REDEEM_DEFAULTED)
    let current = transition(order, "REDEEMING", {
      redeemAttempts: (order.redeemAttempts ?? 0) + 1,
    });
    this.store.save(current);

    const result = await this.redeemer.redeemWithTag(
      redeemAmount,
      order.merchantXrplAddress!,
      order.merchantXrplDestinationTag ?? 0,
      fees,
    );
    if (!result.ok || !result.flareTxHash) {
      if (result.dryRun) {
        // dry-run: leave in REDEEMING (would-redeem recorded)
        return this.store.get(current.id)!;
      }
      // failure (not default yet) — check retry policy
      return this.applyRetryOrRefund(current, "redeem failed: " + (result.error ?? "unknown"));
    }

    // record the redeem tx hash + requestId (patch in-state, no transition)
    current = { ...current, redeemTxHash: result.flareTxHash, redemptionRequestId: result.requestId };
    this.store.save(current);

    // In production: poll XRPL for the agent payout → confirmXRPRedemptionPayment,
    // or call redemptionPaymentDefault if the deadline passes. For Phase 2 we mark
    // REDEEMED optimistically once redeemWithTag is accepted (the agent is then
    // obligated to pay; default handling is in handleRedemptionDefault).
    current = transition(current, "REDEEMED", {
      redemptionPaymentTxHash: undefined, // set when the agent payout confirms
    });
    this.store.save(current);
    await this.fireWebhook(current, result.flareTxHash);
    return current;
  }

  /** Handle a redemption default (agent missed the payout deadline). */
  async handleRedemptionDefault(orderId: string): Promise<Order> {
    const order = this.store.get(orderId);
    if (!order) throw new Error(`order ${orderId} not found`);
    let current = transition(order, "REDEEM_DEFAULTED");
    this.store.save(current);
    return this.applyRetryOrRefund(current, "agent missed payout deadline");
  }

  /** Apply the retry/refund policy after a redemption default or failure. */
  private async applyRetryOrRefund(order: Order, reason: string): Promise<Order> {
    const policy = decideRefundPolicy({
      order: this.store.get(order.id)!,
      paidDrops: order.quote.xrpAmountDrops,
      maxRedeemAttempts: this.cfg.maxRedeemAttempts ?? 3,
    });
    if (policy.action === "RETRY" && this.redeemer) {
      // retry redemption (uses the still-minted FXRP)
      return this.redeemOrder(this.store.get(order.id)!);
    }
    if (policy.action === "REFUND") {
      return this.refundOrder(this.store.get(order.id)!, reason);
    }
    // REJECT or NO_ACTION → FAILED
    const failed = transition(this.store.get(order.id)!, "FAILED", { error: reason });
    this.store.save(failed);
    await this.fireWebhook(failed, "");
    return failed;
  }

  /** Refund the customer: operator sends XRP back (covers the sunk mint fee). */
  private async refundOrder(order: Order, reason: string): Promise<Order> {
    // In production this issues an XRPL Payment from the operator wallet to the
    // customer's source address. The refund amount is the customer payment minus
    // the sunk mint fee (non-recoverable) — the operator waives its own fee.
    const refundAmount = computeRefundAmount(
      order.quote.xrpAmountDrops,
      order.feeBreakdown?.mintFeeDrops ?? 0n,
      order.feeBreakdown?.operatorFeeDrops ?? 0n,
    );
    // stub: a real implementation sends the XRPL payment and records the tx hash.
    const refunded = transition(order, "REFUNDED", {
      refundTxHash: undefined,
      error: `${reason}; refund ${refundAmount} drops (operator-funded)`,
    });
    this.store.save(refunded);
    await this.fireWebhook(refunded, "");
    return refunded;
  }

  /** Expire orders whose quotes have lapsed. */
  expireStale(nowSec = Math.floor(Date.now() / 1000)): Order[] {
    const open = this.store.listOpen("AWAITING_PAYMENT");
    const expired: Order[] = [];
    for (const o of open) {
      if (!isQuoteLive(o.quote, nowSec)) {
        const updated = transition(o, "EXPIRED");
        this.store.save(updated);
        if (o.tagId !== undefined) this.tagPool.release(o.tagId);
        expired.push(updated);
      }
    }
    return expired;
  }

  private async fireWebhook(order: Order, flareTxHash: string): Promise<void> {
    if (!this.cfg.webhookUrl) return;
    const fb = order.feeBreakdown;
    const payload = {
      orderId: order.id,
      flareTxHash,
      fdcAttestationId: order.matchedTxHash ?? "",
      fxrpSettled: order.settlement === "FXRP" ? (fb?.merchantFxrpDrops.toString() ?? "0") : "0",
      status: order.status,
      settlementMode: order.settlement,
      merchantXrpDrops: order.settlement === "XRP" ? (fb?.merchantXrpDrops.toString() ?? "0") : undefined,
      redemptionRequestId: order.redemptionRequestId?.toString(),
      redemptionPaymentTxHash: order.redemptionPaymentTxHash,
      feeBreakdown: fb
        ? {
            customerXrpDrops: fb.customerXrpDrops.toString(),
            mintFeeDrops: fb.mintFeeDrops.toString(),
            fxrpMintedDrops: fb.fxrpMintedDrops.toString(),
            redeemFeeDrops: fb.redeemFeeDrops.toString(),
            operatorFeeDrops: fb.operatorFeeDrops.toString(),
            merchantFxrpDrops: fb.merchantFxrpDrops.toString(),
            merchantXrpDrops: fb.merchantXrpDrops.toString(),
          }
        : undefined,
    };
    const signed = signWebhook(payload, this.cfg.webhookSecret);
    try {
      await deliverWebhook(this.cfg.webhookUrl, signed);
    } catch {
      // best-effort; merchant can also poll getOrder()
    }
  }

  // --- test helpers ---
  _getStore(): OrderStore {
    return this.store;
  }
  _getTagPool(): TagPool {
    return this.tagPool;
  }
  _injectOrder(order: Order): void {
    this.store.save(order);
  }
}

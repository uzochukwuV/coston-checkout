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
  type OrderAction,
} from "./order.js";
import { OrderStore, type IOrderStore } from "./order-store.js";
import { TagPool } from "./tag-pool.js";
import { matchPaymentToOrder, matchPaymentToFlowCOrder } from "./matcher.js";
import { signWebhook, deliverWebhook, type SignedWebhook } from "./webhook.js";
import type { Executor } from "./executor.js";
import type { Redeemer } from "./redeemer.js";
import { priceOrder } from "./pricing.js";
import { decideRefundPolicy, computeRefundAmount } from "./refund.js";
import { buildUserOp, abiEncodeUserOp, totalCallValue, type Call } from "./userop.js";
import {
  buildTransferCall,
  buildVaultDepositCall,
  buildRawCall,
} from "./actions.js";

/** Build the Call[] batch for a Flow C OrderAction spec. Pure. */
function buildCallsForAction(action: OrderAction, amountDrops: bigint): Call[] {
  switch (action.kind) {
    case "transfer": {
      if (!action.fxrpTokenAddress) throw new Error("transfer action requires fxrpTokenAddress");
      if (!action.recipient) throw new Error("transfer action requires recipient");
      return [buildTransferCall(action.fxrpTokenAddress, action.recipient, amountDrops)];
    }
    case "deposit": {
      if (!action.targetAddress) throw new Error("deposit action requires targetAddress (vault)");
      return [
        buildVaultDepositCall(
          action.targetAddress,
          amountDrops,
          action.depositSelector ?? "deposit",
        ),
      ];
    }
    case "swap": {
      // swap = a generic single call to a DEX; caller supplies the pre-encoded
      // calldata in rawCallData (e.g. exactInputSingle).
      if (!action.targetAddress) throw new Error("swap action requires targetAddress (DEX)");
      if (!action.rawCallData) throw new Error("swap action requires rawCallData (encoded swap)");
      return [buildRawCall(action.targetAddress, action.rawCallData, action.rawValueWei ?? 0n)];
    }
    case "raw": {
      if (!action.targetAddress) throw new Error("raw action requires targetAddress");
      if (!action.rawCallData) throw new Error("raw action requires rawCallData");
      return [buildRawCall(action.targetAddress, action.rawCallData, action.rawValueWei ?? 0n)];
    }
    default:
      throw new Error(`unknown action kind: ${(action as OrderAction).kind}`);
  }
}

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
  /** For Flow C: the atomic post-mint action spec. */
  action?: OrderAction;
  /** For Flow C: the customer's XRPL address (their smart account owner). */
  customerXrplAddress?: string;
  /** For Flow C: resolved personal-account address (smart account). */
  personalAccountAddress?: `0x${string}`;
  /** For Flow C: the current memo nonce for the personal account. */
  userOpNonce?: bigint;
  /** For Flow C: the 0xFE memo user-op hash the customer committed to. */
  userOpHash?: `0x${string}`;
}

export class CheckoutService {
  private store: IOrderStore;
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
    store?: IOrderStore,
  ) {
    this.store = store ?? new OrderStore();
  }

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
    if (settlement === "AUTO") {
      if (!input.action) throw new Error("Flow C (AUTO settlement) requires an action spec");
      if (!input.personalAccountAddress) throw new Error("Flow C requires personalAccountAddress");
      if (input.userOpNonce === undefined) throw new Error("Flow C requires userOpNonce");
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
      action: settlement === "AUTO" ? input.action : undefined,
      customerXrplAddress: settlement === "AUTO" ? input.customerXrplAddress : undefined,
      personalAccountAddress: settlement === "AUTO" ? input.personalAccountAddress : undefined,
      userOpNonce: settlement === "AUTO" ? input.userOpNonce : undefined,
      userOpHash: settlement === "AUTO" ? input.userOpHash : undefined,
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

    // allocate a tag (order binding) — Flow A/B use MintingTagManager tags;
    // Flow C binds by the 0xFE memo hash instead, so no tag is allocated.
    if (settlement !== "AUTO" && this.tagPool.totalCount() > 0) {
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
      const order = await this.matchAndSettle(payment, open);
      if (order && (order.status === "SETTLED" || order.status === "REDEEMED")) {
        settled.push(order);
      }
    }
    return settled;
  }

  /** Process a single matched payment (for tests / explicit dispatch). */
  async processPayment(payment: VaultPayment): Promise<Order | undefined> {
    const open = this.store.listOpen("AWAITING_PAYMENT");
    return this.matchAndSettle(payment, open);
  }

  /** Match a payment (Flow A/B by tag, Flow C by 0xFE memo hash) then settle. */
  private async matchAndSettle(payment: VaultPayment, open: Order[]): Promise<Order | undefined> {
    // Flow C: match by 0xFE memo user-op hash (no destination tag)
    let result = matchPaymentToFlowCOrder(payment, open);
    // Flow A/B: match by destination tag
    if (!result.matched) {
      result = matchPaymentToOrder(payment, open);
    }
    if (!result.matched || !result.order) return undefined;
    let order = transition(result.order, "PAYMENT_DETECTED", {
      matchedTxHash: payment.txHash,
      customerXrplAddress: result.order.customerXrplAddress ?? payment.sourceAddress,
    });
    this.store.save(order);
    return this.settleOrder(order);
  }

  /**
   * Settle a detected order. Dispatches by settlement mode:
   *   FXRP → mint to merchant EOA (executeDirectMinting)
   *   XRP  → mint to operator, then redeemWithTag (Flow B)
   *   AUTO → atomic mint + user op (executeDirectMintingWithData, Flow C)
   * Shared by pollAndMatch + processPayment.
   */
  private async settleOrder(order: Order): Promise<Order> {
    let current = transition(order, "SETTLING");
    this.store.save(current);

    // Flow C: atomic mint + user op via executeDirectMintingWithData
    if (current.settlement === "AUTO") {
      return this.settleFlowC(current);
    }

    // Flow A / B: mint FXRP via the executor (FDC proof → executeDirectMinting)
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

  /**
   * Flow C: build the PackedUserOperation from the order's action, ABI-encode it,
   * and call executeDirectMintingWithData. Atomic — a revert rolls back the mint
   * (no FXRP minted; XRP stays at the Core Vault, recoverable via 0xE0 skip-memo).
   */
  private async settleFlowC(order: Order): Promise<Order> {
    if (!order.action || !order.personalAccountAddress || order.userOpNonce === undefined) {
      const failed = transition(order, "FAILED", { error: "Flow C order missing action/personalAccount/nonce" });
      this.store.save(failed);
      return failed;
    }
    const amountDrops = order.action.amountDrops ?? order.feeBreakdown?.fxrpMintedDrops ?? 0n;
    if (amountDrops <= 0n) {
      const failed = transition(order, "FAILED", { error: "Flow C: nothing to mint+route (amount 0)" });
      this.store.save(failed);
      return failed;
    }
    // build the Call[] for the action
    let calls: import("./actions.js").Call[];
    try {
      calls = buildCallsForAction(order.action, amountDrops);
    } catch (e) {
      const failed = transition(order, "FAILED", { error: `action build failed: ${(e as Error).message}` });
      this.store.save(failed);
      return failed;
    }
    const userOp = buildUserOp(order.personalAccountAddress, order.userOpNonce, calls);
    const userOpData = abiEncodeUserOp(userOp);
    const msgValue = totalCallValue(calls);

    const result = await this.executor.settleWithData(
      order.matchedTxHash!,
      userOpData,
      msgValue,
      true,
    );
    if (!result.ok || !result.flareTxHash) {
      if (!result.dryRun) {
        // Atomic revert → no FXRP minted. XRP remains at the Core Vault.
        const failed = transition(order, "FAILED", {
          error: `Flow C revert (no mint): ${result.error ?? "unknown"}. Recover via 0xE0 skip-memo.`,
        });
        this.store.save(failed);
        await this.fireWebhook(failed, "");
        return failed;
      }
      return this.store.get(order.id)!;
    }
    // atomic success — mint + user op in one tx
    const current = transition(order, "SETTLED", {
      settleTxHash: result.flareTxHash,
      userOpHash: order.userOpHash, // the pre-committed 0xFE memo hash
    });
    this.store.save(current);
    await this.fireWebhook(current, result.flareTxHash);
    return current;
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
      fxrpSettled: (order.settlement === "FXRP" || order.settlement === "AUTO") ? (fb?.merchantFxrpDrops.toString() ?? "0") : "0",
      status: order.status,
      settlementMode: order.settlement,
      merchantXrpDrops: order.settlement === "XRP" ? (fb?.merchantXrpDrops.toString() ?? "0") : undefined,
      // Flow C fields
      userOpHash: order.userOpHash,
      actionKind: order.action?.kind,
      personalAccountAddress: order.personalAccountAddress,
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
  _getStore(): IOrderStore {
    return this.store;
  }
  _getTagPool(): TagPool {
    return this.tagPool;
  }
  _injectOrder(order: Order): void {
    this.store.save(order);
  }
}

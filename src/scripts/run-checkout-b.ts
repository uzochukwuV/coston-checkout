/**
 * Phase 2 demo runner — validates Flow B (settle-to-XRP) pricing + orchestration
 * against live Coston2 fee params (DRY_RUN).
 *
 * What this validates off-broadcast:
 *   - live redemption fee params (minimumRedeemAmountUBA, CoreVaultRedemptionFeeBIPS)
 *   - Flow B order creation with full fee-breakdown pricing
 *   - the full Flow B state-machine path with stubbed mint+redeem
 *   - the redemption-default → retry → refund policy path
 *
 * No PRIVATE_KEY / XRPL_SEED needed. No transactions are broadcast.
 *
 * Usage: npx tsx src/scripts/run-checkout-b.ts
 */
import { resolveAddresses } from "../chain/registry.js";
import { AssetManagerClient } from "../chain/asset-manager.js";
import { FtsoClient, XRP_USD_FEED_ID } from "../chain/ftso.js";
import { XrplWatcher } from "../chain/xrpl-watcher.js";
import { FdcClient } from "../chain/fdc.js";
import { CheckoutService, type CheckoutConfig } from "../checkout/checkout-service.js";
import { Executor, type ExecuteResult } from "../checkout/executor.js";
import { Redeemer, type RedeemResult } from "../checkout/redeemer.js";
import type { VaultPayment } from "../chain/xrpl-watcher.js";

const rpcUrl = process.env.FLARE_RPC_URL ?? "https://coston2-api.flare.network/ext/bc/C/rpc";
const xrplWsUrl = process.env.XRPL_WS_URL ?? "wss://s.altnet.rippletest.net:51233";
const merchantFlare = (process.env.MERCHANT_FLARE ?? "0x000000000000000000000000000000000000dEaD") as `0x${string}`;

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() + "n" : v;
}

async function main() {
  console.log("\n=== Phase 2 — Flow B (settle-to-XRP) DRY_RUN ===\n");

  // resolve live params
  const addresses = await resolveAddresses(rpcUrl);
  const assetManager = AssetManagerClient.fromRpc(addresses.assetManagerFXRP, rpcUrl);
  const fees = await assetManager.getFeeParams();
  console.log("Mint fees:  bips=" + fees.mintFeeBIPS + " min=" + fees.mintMinimumFeeUBA + " exec=" + fees.executorFeeUBA);
  console.log("Redeem fees: bips=" + fees.redeemFeeBIPS + " minRedeem=" + fees.minimumRedeemAmountUBA);

  const ftso = await FtsoClient.create(rpcUrl);
  const xrpUsd = await ftso.getFeed(XRP_USD_FEED_ID);
  console.log("XRP/USD:", FtsoClient.toDisplayPrice(xrpUsd), "(stale=" + xrpUsd.stale + ")");

  const watcher = new XrplWatcher(xrplWsUrl);
  await watcher.connect();
  const fdc = new FdcClient();

  // stubbed executor + redeemer (DRY_RUN — no broadcast)
  const executor = new Executor({
    rpcUrl, assetManagerAddress: addresses.assetManagerFXRP, fdc,
    proofOwner: merchantFlare, dryRun: true,
  });
  // override settle to simulate a successful mint (dry-run path leaves SETTLING,
  // so we inject a success stub to demonstrate the full Flow B path)
  const stubExecutor = {
    settle: async (): Promise<ExecuteResult> => ({
      ok: true, dryRun: false, flareTxHash: "0xmint" + "0".repeat(56),
    }),
  } as unknown as Executor;
  void executor;

  const stubRedeemer = {
    redeemWithTag: async (amount: bigint): Promise<RedeemResult> => ({
      ok: true, dryRun: false, flareTxHash: "0xredeem" + "0".repeat(54),
      requestId: 42n, amountUBA: amount,
    }),
  } as unknown as Redeemer;

  const cfg: CheckoutConfig = {
    merchantId: "demo-merchant",
    merchantFlareAddress: merchantFlare,
    merchantXrplAddress: "rDemoMerchant",
    merchantXrplDestinationTag: 12345,
    webhookSecret: "demo-secret",
    serviceFeeBps: 50,
    maxRedeemAttempts: 3,
  };
  const svc = new CheckoutService(cfg, ftso, watcher, stubExecutor, assetManager, stubRedeemer);
  // seed a tag so the matcher can bind a payment
  svc._getTagPool().addReserved({
    tagId: 1001, ownerAddress: "operator", boundRecipient: merchantFlare, available: true,
  });

  // --- create a Flow B order ---
  console.log("\n--- create Flow B order ($10, settle-to-XRP) ---");
  const order = await svc.createOrder({ usdAmount: 10, settlement: "XRP" });
  console.log(JSON.stringify(order, bigintReplacer, 2));

  const fb = order.feeBreakdown!;
  console.log("\nFee breakdown (drops):");
  console.log("  customer pays:    " + fb.customerXrpDrops);
  console.log("  - mint fee:       " + fb.mintFeeDrops);
  console.log("  = FXRP minted:    " + fb.fxrpMintedDrops);
  console.log("  - redeem fee:     " + fb.redeemFeeDrops);
  console.log("  - operator fee:   " + fb.operatorFeeDrops);
  console.log("  = merchant XRP:   " + fb.merchantXrpDrops);

  // --- simulate a matching XRPL payment ---
  console.log("\n--- process payment → mint → redeem ---");
  const payment: VaultPayment = {
    txHash: "0xrplpayment" + "0".repeat(46),
    sourceAddress: "rCustomer",
    destinationTag: order.tagId,
    amountDrops: order.quote.xrpAmountDrops.toString(),
    ledgerIndex: 100,
  };
  const result = await svc.processPayment(payment);
  console.log("final status:", result?.status);
  console.log("redeem tx:", result?.redeemTxHash);
  console.log("request id:", result?.redemptionRequestId?.toString());

  // --- simulate a redemption default + retry ---
  console.log("\n--- simulate redemption default → retry ---");
  const redeemingOrder = { ...result!, status: "REDEEMING" as const, redeemAttempts: 1 };
  svc._injectOrder(redeemingOrder);
  const afterDefault = await svc.handleRedemptionDefault(redeemingOrder.id);
  console.log("after default:", afterDefault.status, "(attempt " + afterDefault.redeemAttempts + ")");

  await watcher.disconnect();
  console.log("\n=== Phase 2 demo complete ===\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

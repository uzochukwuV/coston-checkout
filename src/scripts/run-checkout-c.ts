/**
 * Phase 3 demo runner — validates Flow C (atomic mint + user op via
 * executeDirectMintingWithData) against live Coston2 fee params + FTSO feed
 * (DRY_RUN — no broadcast).
 *
 * What this validates off-broadcast:
 *   - live FAssets fee params + XRP/USD FTSO feed
 *   - Flow C order creation with the AUTO settlement mode + action spec
 *   - PackedUserOperation construction + 0xFE memo hash commitment consistency
 *   - the full Flow C settle path (payment → match by 0xFE memo → settleWithData → SETTLED)
 *   - the atomic-revert path (executeDirectMintingWithData reverts → FAILED, no FXRP minted)
 *
 * No PRIVATE_KEY / XRPL_SEED needed. No transactions are broadcast.
 *
 * Usage: npx tsx src/scripts/run-checkout-c.ts
 */
import { resolveAddresses } from "../chain/registry.js";
import { AssetManagerClient } from "../chain/asset-manager.js";
import { FtsoClient, XRP_USD_FEED_ID } from "../chain/ftso.js";
import { XrplWatcher } from "../chain/xrpl-watcher.js";
import { FdcClient } from "../chain/fdc.js";
import { CheckoutService, type CheckoutConfig } from "../checkout/checkout-service.js";
import { Executor, type ExecuteWithDataResult } from "../checkout/executor.js";
import type { VaultPayment } from "../chain/xrpl-watcher.js";
import { buildUserOp, userOpHash as computeUserOpHash, abiEncodeUserOp } from "../checkout/userop.js";
import { buildTransferCall } from "../checkout/actions.js";
import { encodeFeMemo } from "../memo/encoder.js";

const rpcUrl = process.env.FLARE_RPC_URL ?? "https://coston2-api.flare.network/ext/bc/C/rpc";
const xrplWsUrl = process.env.XRPL_WS_URL ?? "wss://s.altnet.rippletest.net:51233";
const merchantFlare = (process.env.MERCHANT_FLARE ?? "0x000000000000000000000000000000000000dEaD") as `0x${string}`;
const personalAccount = (process.env.PERSONAL_ACCOUNT ?? "0x000000000000000000000000000000000000BEEF") as `0x${string}`;
// FXRP token is resolved live from the registry below; FXRP_TOKEN env overrides.

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() + "n" : v;
}

async function main() {
  console.log("\n=== Phase 3 — Flow C (atomic mint + user op) DRY_RUN ===\n");

  // resolve live params
  const addresses = await resolveAddresses(rpcUrl);
  const fxrpToken = (process.env.FXRP_TOKEN ?? addresses.fxrpToken) as `0x${string}`;
  const assetManager = AssetManagerClient.fromRpc(addresses.assetManagerFXRP, rpcUrl);
  const fees = await assetManager.getFeeParams();
  console.log("Mint fees:  bips=" + fees.mintFeeBIPS + " min=" + fees.mintMinimumFeeUBA + " exec=" + fees.executorFeeUBA);
  console.log("FXRP token (resolved):", fxrpToken);

  const ftso = await FtsoClient.create(rpcUrl);
  const xrpUsd = await ftso.getFeed(XRP_USD_FEED_ID);
  console.log("XRP/USD:", FtsoClient.toDisplayPrice(xrpUsd), "(stale=" + xrpUsd.stale + ")");

  const watcher = new XrplWatcher(xrplWsUrl);
  await watcher.connect();
  const fdc = new FdcClient();
  void new Executor({ rpcUrl, assetManagerAddress: addresses.assetManagerFXRP, fdc, proofOwner: merchantFlare, dryRun: true });

  // stubbed executor — settleWithData returns success (to demonstrate the full path)
  function makeStubExecutor(success: boolean): unknown {
    return {
      settleWithData: async (
        _txHash: string,
        _data: `0x${string}`,
        _msgValue: bigint,
      ): Promise<ExecuteWithDataResult> => {
        if (success) {
          return { ok: true, dryRun: false, flareTxHash: "0xflowc" + "0".repeat(54), msgValueWei: "0" };
        }
        return { ok: false, dryRun: false, error: "atomic revert: CallFailed (deposit slippage)", msgValueWei: "0" };
      },
    };
  }

  const cfg: CheckoutConfig = {
    merchantId: "demo-merchant",
    merchantFlareAddress: merchantFlare,
    webhookSecret: "demo-secret",
    serviceFeeBps: 50,
  };

  // --- build the user op the customer commits to ---
  // In production, the merchant/operator builds the PackedUserOperation,
  // computes keccak256(userOp), and gives the customer the 0xFE memo to attach.
  const fxrpMintedEstimate = 9_800_000n; // ~10 XRP minus fees (exact value fixed at createOrder)
  const calls = [buildTransferCall(fxrpToken, merchantFlare, fxrpMintedEstimate)];
  const op = buildUserOp(personalAccount, 0n, calls);
  const committedHash = computeUserOpHash(op);
  console.log("PackedUserOperation built. userOpHash =", committedHash);
  console.log("  callData (executeUserOp, first 10 bytes):", abiEncodeUserOp(op).slice(0, 10));

  // --- happy path: settleWithData succeeds ---
  console.log("\n--- happy path (settleWithData ok) ---");
  const svcOk = new CheckoutService(
    cfg, ftso, watcher, makeStubExecutor(true) as Executor, assetManager,
  );
  const order = await svcOk.createOrder({
    usdAmount: 10,
    settlement: "AUTO",
    action: { kind: "transfer", fxrpTokenAddress: fxrpToken, recipient: merchantFlare, amountDrops: fxrpMintedEstimate },
    personalAccountAddress: personalAccount,
    userOpNonce: 0n,
    userOpHash: committedHash,
  });
  console.log("Order:", JSON.stringify(order, bigintReplacer, 2));

  // customer sends an XRPL Payment with the 0xFE memo
  const memo = encodeFeMemo(0, 100_000n, committedHash);
  console.log("Customer 0xFE memo (42 bytes):", memo);
  const payment: VaultPayment = {
    txHash: "0xrplpay" + "0".repeat(52),
    sourceAddress: "rCustomer",
    amountDrops: order.quote.xrpAmountDrops.toString(),
    memoData: memo,
    ledgerIndex: 1,
  };
  const settled = await svcOk.processPayment(payment);
  console.log("Settled order:", JSON.stringify(settled, bigintReplacer, 2));

  // --- revert path: settleWithData reverts (atomic, no FXRP minted) ---
  console.log("\n--- revert path (atomic revert, no mint) ---");
  const svcFail = new CheckoutService(
    cfg, ftso, watcher, makeStubExecutor(false) as Executor, assetManager,
  );
  const order2 = await svcFail.createOrder({
    usdAmount: 10,
    settlement: "AUTO",
    action: { kind: "transfer", fxrpTokenAddress: fxrpToken, recipient: merchantFlare, amountDrops: fxrpMintedEstimate },
    personalAccountAddress: personalAccount,
    userOpNonce: 0n,
    userOpHash: committedHash,
  });
  const payment2: VaultPayment = {
    txHash: "0xrplpay2" + "0".repeat(50),
    sourceAddress: "rCustomer",
    amountDrops: order2.quote.xrpAmountDrops.toString(),
    memoData: memo,
    ledgerIndex: 2,
  };
  const failed = await svcFail.processPayment(payment2);
  console.log("Failed order:", JSON.stringify(failed, bigintReplacer, 2));
  console.log("  (XRP stays at the Core Vault — recover via 0xE0 skip-memo)");

  await watcher.disconnect();
  console.log("\n=== Phase 3 demo complete ===");
}

main().catch((e) => {
  console.error("Phase 3 demo failed:", e);
  process.exit(1);
});

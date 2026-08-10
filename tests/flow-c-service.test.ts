/**
 * Phase 3 — Flow C orchestration tests (stubbed executor).
 *
 * Exercises the full settleFlowC path: create an AUTO order → process a payment
 * with a 0xFE memo → the service builds the PackedUserOperation, calls the
 * stubbed executor.settleWithData, and transitions to SETTLED. Also covers the
 * atomic-revert (FAILED) path.
 */
import { describe, it, expect } from "vitest";
import { CheckoutService } from "../src/checkout/checkout-service.js";
import type { Executor, ExecuteWithDataResult } from "../src/checkout/executor.js";
import type { AssetManagerClient, FeeParams } from "../src/chain/asset-manager.js";
import { FtsoClient, XRP_USD_FEED_ID } from "../src/chain/ftso.js";
import type { XrplWatcher, VaultPayment } from "../src/chain/xrpl-watcher.js";
import { buildUserOp, userOpHash, abiEncodeUserOp } from "../src/checkout/userop.js";
import { buildTransferCall } from "../src/checkout/actions.js";
import { encodeFeMemo } from "../src/memo/encoder.js";
import type { Order, OrderAction } from "../src/checkout/order.js";

const MERCHANT = ("0x" + "ab".repeat(20)) as `0x${string}`;
const FXRP = ("0x" + "0b".repeat(20)) as `0x${string}`;
const PERSONAL_ACCOUNT = ("0x" + "11".repeat(20)) as `0x${string}`;

const FEES: FeeParams = {
  mintFeeBIPS: 25n,
  mintMinimumFeeUBA: 100_000n,
  executorFeeUBA: 100_000n,
  redeemFeeBIPS: 10n,
  minimumRedeemAmountUBA: 1_000_000n,
};

function makeStubs(opts: { settleOk: boolean } = { settleOk: true }) {
  const ftso = {
    getFeed: async (_id: string) => ({
      value: 1_000_000n, decimals: 6, stale: false, timestamp: Math.floor(Date.now() / 1000),
    }),
  } as unknown as FtsoClient;
  const watcher = {} as unknown as XrplWatcher;
  const executor = {
    settleWithData: async (
      _txHash: string,
      _data: `0x${string}`,
      _msgValue: bigint,
    ): Promise<ExecuteWithDataResult> => {
      if (opts.settleOk) {
        return { ok: true, dryRun: false, flareTxHash: "0xflowc" + "0".repeat(54), msgValueWei: "0" };
      }
      return { ok: false, dryRun: false, error: "atomic revert: CallFailed", msgValueWei: "0" };
    },
  } as unknown as Executor;
  const assetManager = {
    getDirectMintingParams: async () => ({ coreVaultXrplAddress: "rVault", feeBIPS: 25n, minimumFeeUBA: 100_000n, executorFeeUBA: 100_000n, othersCanExecuteAfterSeconds: 7200n, hourlyLimitUBA: 100_000_000_000n, dailyLimitUBA: 500_000_000_000n, mintingTagManager: MERCHANT, redeemWithTagSupported: true }),
    getFeeParams: async () => FEES,
    getRedemptionParams: async () => ({ minimumRedeemAmountUBA: FEES.minimumRedeemAmountUBA, redemptionFeeBIPS: FEES.redeemFeeBIPS, minimumRedeemLots: 10n }),
  } as unknown as AssetManagerClient;
  return { ftso, watcher, executor, assetManager };
}

function makeService(opts?: { settleOk?: boolean }) {
  const stubs = makeStubs({ settleOk: opts?.settleOk ?? true });
  const svc = new CheckoutService(
    {
      merchantId: "m",
      merchantFlareAddress: MERCHANT,
      webhookSecret: "secret",
      serviceFeeBps: 50,
    },
    stubs.ftso,
    stubs.watcher,
    stubs.executor,
    stubs.assetManager,
  );
  return { svc, executor: stubs.executor };
}

describe("Flow C — atomic mint + user op orchestration", () => {
  it("creates an AUTO order with an action + userOpHash", async () => {
    const { svc } = makeService();
    const action: OrderAction = {
      kind: "transfer",
      fxrpTokenAddress: FXRP,
      recipient: MERCHANT,
    };
    // build the user op the customer will commit to
    const calls = [buildTransferCall(FXRP, MERCHANT, 9_800_000n)];
    const op = buildUserOp(PERSONAL_ACCOUNT, 0n, calls);
    const hash = userOpHash(op);
    const order = await svc.createOrder({
      usdAmount: 10,
      settlement: "AUTO",
      action,
      personalAccountAddress: PERSONAL_ACCOUNT,
      userOpNonce: 0n,
      userOpHash: hash,
    });
    expect(order.settlement).toBe("AUTO");
    expect(order.action?.kind).toBe("transfer");
    expect(order.userOpHash).toBe(hash);
    expect(order.userOpNonce).toBe(0n);
    expect(order.tagId).toBeUndefined(); // Flow C binds by memo hash, no tag
    expect(order.status).toBe("AWAITING_PAYMENT");
    // AUTO prices like Flow A (no redeem fee); merchant gets the full minted FXRP
    const minted = order.feeBreakdown!.fxrpMintedDrops;
    expect(minted).toBe(order.feeBreakdown!.merchantFxrpDrops);
    expect(order.feeBreakdown?.redeemFeeDrops).toBe(0n);
  });

  it("requires an action + personalAccount + nonce for AUTO", async () => {
    const { svc } = makeService();
    await expect(svc.createOrder({ usdAmount: 10, settlement: "AUTO" })).rejects.toThrow(/action spec/);
    await expect(
      svc.createOrder({ usdAmount: 10, settlement: "AUTO", action: { kind: "transfer", fxrpTokenAddress: FXRP, recipient: MERCHANT } }),
    ).rejects.toThrow(/personalAccountAddress/);
  });

  it("processes a Flow C payment through to SETTLED", async () => {
    const { svc } = makeService({ settleOk: true });
    const calls = [buildTransferCall(FXRP, MERCHANT, 9_800_000n)];
    const op = buildUserOp(PERSONAL_ACCOUNT, 0n, calls);
    const hash = userOpHash(op);
    const order = await svc.createOrder({
      usdAmount: 10,
      settlement: "AUTO",
      action: { kind: "transfer", fxrpTokenAddress: FXRP, recipient: MERCHANT },
      personalAccountAddress: PERSONAL_ACCOUNT,
      userOpNonce: 0n,
      userOpHash: hash,
    });
    // build the 0xFE memo the customer sends
    const memo = encodeFeMemo(0, 100_000n, hash);
    const payment: VaultPayment = {
      txHash: "0xrplpay" + "0".repeat(52),
      sourceAddress: "rCustomer",
      amountDrops: order.quote.xrpAmountDrops.toString(),
      memoData: memo,
      ledgerIndex: 1,
    };
    const result = await svc.processPayment(payment);
    expect(result?.status).toBe("SETTLED");
    expect(result?.settleTxHash).toMatch(/^0xflowc/);
    expect(result?.userOpHash).toBe(hash);
    expect(result?.customerXrplAddress).toBe("rCustomer");
  });

  it("fails to SETTLED→FAILED on atomic revert (no FXRP minted)", async () => {
    const { svc } = makeService({ settleOk: false });
    const calls = [buildTransferCall(FXRP, MERCHANT, 9_800_000n)];
    const op = buildUserOp(PERSONAL_ACCOUNT, 0n, calls);
    const hash = userOpHash(op);
    const order = await svc.createOrder({
      usdAmount: 10,
      settlement: "AUTO",
      action: { kind: "transfer", fxrpTokenAddress: FXRP, recipient: MERCHANT },
      personalAccountAddress: PERSONAL_ACCOUNT,
      userOpNonce: 0n,
      userOpHash: hash,
    });
    const memo = encodeFeMemo(0, 100_000n, hash);
    const payment: VaultPayment = {
      txHash: "0xrplpay" + "0".repeat(52),
      sourceAddress: "rCustomer",
      amountDrops: order.quote.xrpAmountDrops.toString(),
      memoData: memo,
      ledgerIndex: 1,
    };
    const result = await svc.processPayment(payment);
    expect(result?.status).toBe("FAILED");
    expect(result?.error).toMatch(/atomic revert/);
    expect(result?.error).toMatch(/0xE0/); // recovery hint
  });

  it("does not match a Flow C payment against a Flow A order", async () => {
    const { svc } = makeService();
    // create a Flow A order (has a tag, no userOpHash)
    const flowA = await svc.createOrder({ usdAmount: 10 }); // default FXRP
    expect(flowA.settlement).toBe("FXRP");
    // a payment with a 0xFE memo but no matching Flow C order → no match
    const calls = [buildTransferCall(FXRP, MERCHANT, 9_800_000n)];
    const op = buildUserOp(PERSONAL_ACCOUNT, 0n, calls);
    const hash = userOpHash(op);
    const memo = encodeFeMemo(0, 100_000n, hash);
    const payment: VaultPayment = {
      txHash: "0xrplpay" + "0".repeat(52),
      sourceAddress: "rCustomer",
      amountDrops: "10000000",
      memoData: memo,
      ledgerIndex: 1,
    };
    const result = await svc.processPayment(payment);
    expect(result).toBeUndefined();
  });

  it("supports a deposit-to-vault action", async () => {
    const { svc } = makeService({ settleOk: true });
    const vault = ("0x" + "44".repeat(20)) as `0x${string}`;
    const calls = [buildTransferCall(FXRP, MERCHANT, 9_800_000n)]; // placeholder for hash
    // build a deposit call instead
    const depositCalls = [
      { target: vault, value: 0n, data: "0xb6b55f25" + abiEncodeUserOp(buildUserOp(PERSONAL_ACCOUNT, 0n, calls)).slice(10) } as const,
    ];
    // For the test we just need a consistent hash; use a deposit action
    const op = buildUserOp(PERSONAL_ACCOUNT, 0n, [
      { target: vault, value: 0n, data: "0xb6b55f250000000000000000000000000000000000000000000000000000000000955a40" as `0x${string}` },
    ]);
    const hash = userOpHash(op);
    const order = await svc.createOrder({
      usdAmount: 10,
      settlement: "AUTO",
      action: { kind: "deposit", targetAddress: vault, depositSelector: "deposit" },
      personalAccountAddress: PERSONAL_ACCOUNT,
      userOpNonce: 0n,
      userOpHash: hash,
    });
    expect(order.action?.kind).toBe("deposit");
    expect(order.action?.targetAddress).toBe(vault);
    // settle
    const memo = encodeFeMemo(0, 100_000n, hash);
    const payment: VaultPayment = {
      txHash: "0xrplpay" + "0".repeat(52),
      sourceAddress: "rCustomer",
      amountDrops: order.quote.xrpAmountDrops.toString(),
      memoData: memo,
      ledgerIndex: 1,
    };
    const result = await svc.processPayment(payment);
    expect(result?.status).toBe("SETTLED");
  });

  it("rejects a malformed action spec at settle time", async () => {
    const { svc } = makeService({ settleOk: true });
    // a transfer action missing the recipient → buildCallsForAction throws
    const op = buildUserOp(PERSONAL_ACCOUNT, 0n, [buildTransferCall(FXRP, MERCHANT, 9_800_000n)]);
    const hash = userOpHash(op);
    const order = await svc.createOrder({
      usdAmount: 10,
      settlement: "AUTO",
      action: { kind: "transfer", fxrpTokenAddress: FXRP, recipient: MERCHANT },
      personalAccountAddress: PERSONAL_ACCOUNT,
      userOpNonce: 0n,
      userOpHash: hash,
    });
    // corrupt the action post-creation (missing recipient)
    const corrupted = { ...order, action: { kind: "transfer", fxrpTokenAddress: FXRP } as OrderAction };
    svc._injectOrder(corrupted);
    const memo = encodeFeMemo(0, 100_000n, hash);
    const payment: VaultPayment = {
      txHash: "0xrplpay" + "0".repeat(52),
      sourceAddress: "rCustomer",
      amountDrops: order.quote.xrpAmountDrops.toString(),
      memoData: memo,
      ledgerIndex: 1,
    };
    const result = await svc.processPayment(payment);
    expect(result?.status).toBe("FAILED");
    expect(result?.error).toMatch(/action build failed/);
  });
});

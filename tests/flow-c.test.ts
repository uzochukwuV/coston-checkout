/**
 * Phase 3 tests — Flow C pure logic: PackedUserOperation builder, action encoders,
 * 0xFE memo hash consistency, Flow C matcher (memo-hash binding).
 */
import { describe, it, expect } from "vitest";
import {
  buildUserOp,
  abiEncodeUserOp,
  userOpHash,
  totalCallValue,
  type Call,
} from "../src/checkout/userop.js";
import {
  buildTransferCall,
  buildVaultDepositCall,
  buildRawCall,
  composeCalls,
} from "../src/checkout/actions.js";
import { encodeFeMemo } from "../src/memo/encoder.js";
import { matchPaymentToFlowCOrder } from "../src/checkout/matcher.js";
import type { Order } from "../src/checkout/order.js";

const SENDER = ("0x" + "11".repeat(20)) as `0x${string}`;
const FXRP = ("0x" + "22".repeat(20)) as `0x${string}`;
const MERCHANT = ("0x" + "33".repeat(20)) as `0x${string}`;
const VAULT = ("0x" + "44".repeat(20)) as `0x${string}`;
const DEX = ("0x" + "55".repeat(20)) as `0x${string}`;

describe("userop — PackedUserOperation builder", () => {
  it("builds a valid user op with the executeUserOp callData", () => {
    const calls = [buildTransferCall(FXRP, MERCHANT, 1_000_000n)];
    const op = buildUserOp(SENDER, 5n, calls);
    expect(op.sender).toBe(SENDER);
    expect(op.nonce).toBe(5n);
    // callData should encode executeUserOp(Call[])
    expect(op.callData.slice(0, 10)).toMatch(/^0x[0-9a-f]{8}$/);
    expect(op.initCode).toBe("0x");
    expect(op.paymasterAndData).toBe("0x");
    expect(op.signature).toBe("0x");
  });

  it("rejects an invalid sender address", () => {
    expect(() => buildUserOp("0xdeadbeef" as `0x${string}`, 0n, [buildTransferCall(FXRP, MERCHANT, 1n)])).toThrow(
      /sender address/,
    );
  });

  it("rejects a negative nonce", () => {
    expect(() => buildUserOp(SENDER, -1n, [buildTransferCall(FXRP, MERCHANT, 1n)])).toThrow(/nonce/);
  });

  it("rejects an empty call batch", () => {
    expect(() => buildUserOp(SENDER, 0n, [])).toThrow(/at least one call/);
  });

  it("rejects an invalid call target", () => {
    expect(() =>
      buildUserOp(SENDER, 0n, [buildRawCall("0xnope" as `0x${string}`, "0x")]),
    ).toThrow(/target address/);
  });
});

describe("userop — ABI encoding + hashing", () => {
  it("abiEncodeUserOp produces deterministic hex", () => {
    const calls = [buildTransferCall(FXRP, MERCHANT, 1_000_000n)];
    const op = buildUserOp(SENDER, 0n, calls);
    const encoded = abiEncodeUserOp(op);
    expect(encoded.startsWith("0x")).toBe(true);
    // re-encode → same bytes (deterministic)
    expect(abiEncodeUserOp(op)).toBe(encoded);
  });

  it("userOpHash is 32 bytes and stable", () => {
    const calls = [buildTransferCall(FXRP, MERCHANT, 1_000_000n)];
    const op = buildUserOp(SENDER, 7n, calls);
    const hash = userOpHash(op);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(userOpHash(op)).toBe(hash);
  });

  it("different nonce → different hash", () => {
    const calls = [buildTransferCall(FXRP, MERCHANT, 1_000_000n)];
    const h0 = userOpHash(buildUserOp(SENDER, 0n, calls));
    const h1 = userOpHash(buildUserOp(SENDER, 1n, calls));
    expect(h0).not.toBe(h1);
  });

  it("different calls → different hash", () => {
    const c1 = [buildTransferCall(FXRP, MERCHANT, 1_000_000n)];
    const c2 = [buildTransferCall(FXRP, MERCHANT, 2_000_000n)];
    expect(userOpHash(buildUserOp(SENDER, 0n, c1))).not.toBe(userOpHash(buildUserOp(SENDER, 0n, c2)));
  });

  it("totalCallValue sums call.value", () => {
    const calls: Call[] = [
      buildRawCall(VAULT, "0x", 100n),
      buildRawCall(DEX, "0x", 200n),
    ];
    expect(totalCallValue(calls)).toBe(300n);
  });
});

describe("actions — call builders", () => {
  it("buildTransferCall encodes transfer(address,uint256)", () => {
    const call = buildTransferCall(FXRP, MERCHANT, 5_000_000n);
    expect(call.target).toBe(FXRP);
    expect(call.value).toBe(0n);
    // selector for transfer(address,uint256) = 0xa9059cbb
    expect(call.data.slice(0, 10)).toBe("0xa9059cbb");
  });

  it("buildTransferCall rejects non-positive amount", () => {
    expect(() => buildTransferCall(FXRP, MERCHANT, 0n)).toThrow(/positive/);
  });

  it("buildVaultDepositCall uses the default deposit selector", () => {
    const call = buildVaultDepositCall(VAULT, 1_000_000n);
    expect(call.target).toBe(VAULT);
    expect(call.value).toBe(0n);
    // selector for deposit(uint256) = 0xb6b55f25
    expect(call.data.slice(0, 10)).toBe("0xb6b55f25");
  });

  it("buildVaultDepositCall accepts a custom selector", () => {
    const call = buildVaultDepositCall(VAULT, 1_000_000n, "stake");
    // selector for stake(uint256)
    expect(call.data.slice(0, 10)).not.toBe("0xb6b55f25");
  });

  it("buildRawCall passes through target+data+value", () => {
    const call = buildRawCall(DEX, "0xdeadbeef" as `0x${string}`, 42n);
    expect(call.target).toBe(DEX);
    expect(call.data).toBe("0xdeadbeef");
    expect(call.value).toBe(42n);
  });

  it("buildRawCall rejects non-0x data", () => {
    expect(() => buildRawCall(DEX, "deadbeef" as `0x${string}`)).toThrow(/0x-prefixed/);
  });

  it("composeCalls rejects an empty batch", () => {
    expect(() => composeCalls([])).toThrow(/empty/);
  });

  it("composeCalls returns a copy", () => {
    const calls = [buildTransferCall(FXRP, MERCHANT, 1n)];
    const composed = composeCalls(calls);
    expect(composed).not.toBe(calls);
    expect(composed).toEqual(calls);
  });
});

describe("Flow C matcher — 0xFE memo hash binding", () => {
  function makeFlowCOrder(overrides: Partial<Order> = {}): Order {
    return {
      id: "ord_test",
      merchantFlareAddress: MERCHANT,
      merchantId: "m",
      settlement: "AUTO",
      quote: {
        usdAmount: 10,
        xrpUsdPrice: 1,
        xrpUsdDecimals: 6,
        xrpAmountDrops: 10_000_000n,
        minAcceptedDrops: 9_800_000n,
        slippageBps: 100,
        serviceFeeBps: 50,
        expiresAt: Math.floor(Date.now() / 1000) + 900,
        createdAt: Math.floor(Date.now() / 1000),
      },
      status: "AWAITING_PAYMENT",
      createdAt: Math.floor(Date.now() / 1000),
      userOpHash: ("0x" + "ab".repeat(32)) as `0x${string}`,
      ...overrides,
    };
  }

  it("matches a payment whose 0xFE memo hash equals the order userOpHash", () => {
    const order = makeFlowCOrder();
    // build a 0xFE memo with the order's userOpHash
    const memo = encodeFeMemo(0, 100_000n, order.userOpHash!);
    const payment = {
      txHash: "0xrpl" + "0".repeat(56),
      sourceAddress: "rCustomer",
      amountDrops: "10000000",
      memoData: memo,
      ledgerIndex: 1,
    };
    const result = matchPaymentToFlowCOrder(payment, [order]);
    expect(result.matched).toBe(true);
    expect(result.order?.id).toBe("ord_test");
    // customer XRPL address is recorded from the payment source
    expect(result.order?.customerXrplAddress).toBe("rCustomer");
  });

  it("does not match when the memo hash differs", () => {
    const order = makeFlowCOrder();
    const otherHash = ("0x" + "cd".repeat(32)) as `0x${string}`;
    const memo = encodeFeMemo(0, 100_000n, otherHash);
    const payment = {
      txHash: "0xrpl",
      sourceAddress: "rCustomer",
      amountDrops: "10000000",
      memoData: memo,
      ledgerIndex: 1,
    };
    const result = matchPaymentToFlowCOrder(payment, [order]);
    expect(result.matched).toBe(false);
  });

  it("rejects a payment with no memo", () => {
    const order = makeFlowCOrder();
    const payment = {
      txHash: "0xrpl",
      sourceAddress: "rCustomer",
      amountDrops: "10000000",
      ledgerIndex: 1,
    };
    const result = matchPaymentToFlowCOrder(payment, [order]);
    expect(result.matched).toBe(false);
    expect(result.reason).toMatch(/no memo/);
  });

  it("rejects a non-0xFE memo", () => {
    const order = makeFlowCOrder();
    // a 32-byte direct-minting memo (0x18 prefix), not 0xFE
    const fakeMemo = "18" + "00".repeat(31);
    const payment = {
      txHash: "0xrpl",
      sourceAddress: "rCustomer",
      amountDrops: "10000000",
      memoData: fakeMemo,
      ledgerIndex: 1,
    };
    const result = matchPaymentToFlowCOrder(payment, [order]);
    expect(result.matched).toBe(false);
    expect(result.reason).toMatch(/0xFE/);
  });

  it("rejects underpayment", () => {
    const order = makeFlowCOrder();
    const memo = encodeFeMemo(0, 100_000n, order.userOpHash!);
    const payment = {
      txHash: "0xrpl",
      sourceAddress: "rCustomer",
      amountDrops: "1000000", // < minAcceptedDrops 9_800_000
      memoData: memo,
      ledgerIndex: 1,
    };
    const result = matchPaymentToFlowCOrder(payment, [order]);
    expect(result.matched).toBe(false);
    expect(result.reason).toMatch(/underpaid/);
  });

  it("rejects an expired order", () => {
    const order = makeFlowCOrder({
      quote: {
        ...makeFlowCOrder().quote,
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      },
    });
    const memo = encodeFeMemo(0, 100_000n, order.userOpHash!);
    const payment = {
      txHash: "0xrpl",
      sourceAddress: "rCustomer",
      amountDrops: "10000000",
      memoData: memo,
      ledgerIndex: 1,
    };
    const result = matchPaymentToFlowCOrder(payment, [order]);
    expect(result.matched).toBe(false);
    expect(result.reason).toMatch(/expired/);
  });

  it("only matches AUTO settlement orders", () => {
    // an FXRP (Flow A) order with the same userOpHash should not match via Flow C
    const fxrpOrder = makeFlowCOrder({ settlement: "FXRP", tagId: 999 });
    const memo = encodeFeMemo(0, 100_000n, fxrpOrder.userOpHash!);
    const payment = {
      txHash: "0xrpl",
      sourceAddress: "rCustomer",
      amountDrops: "10000000",
      memoData: memo,
      ledgerIndex: 1,
    };
    const result = matchPaymentToFlowCOrder(payment, [fxrpOrder]);
    expect(result.matched).toBe(false);
  });
});

describe("Flow C — end-to-end memo ↔ userOp hash consistency", () => {
  it("the 0xFE memo hash equals userOpHash of the built user op", () => {
    const calls = [buildTransferCall(FXRP, MERCHANT, 9_800_000n)];
    const op = buildUserOp(SENDER, 3n, calls);
    const hash = userOpHash(op);
    const memo = encodeFeMemo(0, 100_000n, hash);
    // the memo's embedded hash (bytes 10-41) must equal the userOpHash
    const memoHash = ("0x" + memo.slice(20, 84)) as `0x${string}`;
    expect(memoHash).toBe(hash);
  });
});

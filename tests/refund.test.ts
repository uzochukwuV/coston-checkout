import { describe, it, expect } from "vitest";
import { decideRefundPolicy, computeRefundAmount } from "../src/checkout/refund.js";
import type { Order } from "../src/checkout/order.js";

function mockOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "ord_1",
    merchantFlareAddress: ("0x" + "ab".repeat(20)) as `0x${string}`,
    merchantId: "m",
    settlement: "XRP",
    quote: {
      usdAmount: 10,
      xrpUsdPrice: 1,
      xrpUsdDecimals: 6,
      xrpAmountDrops: 10_100_000n,
      minAcceptedDrops: 10_000_000n,
      slippageBps: 100,
      serviceFeeBps: 0,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      createdAt: Math.floor(Date.now() / 1000),
    },
    status: "AWAITING_PAYMENT",
    createdAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe("decideRefundPolicy", () => {
  it("REJECT when underpaid below min", () => {
    const r = decideRefundPolicy({
      order: mockOrder(),
      paidDrops: 5_000_000n,
      maxRedeemAttempts: 3,
    });
    expect(r.action).toBe("REJECT");
    expect(r.reason).toMatch(/underpaid/);
  });

  it("CREDIT when overpaid", () => {
    const r = decideRefundPolicy({
      order: mockOrder(),
      paidDrops: 20_000_000n,
      maxRedeemAttempts: 3,
    });
    expect(r.action).toBe("CREDIT");
  });

  it("NO_ACTION when paid within range", () => {
    const r = decideRefundPolicy({
      order: mockOrder(),
      paidDrops: 10_100_000n,
      maxRedeemAttempts: 3,
    });
    expect(r.action).toBe("NO_ACTION");
  });

  it("RETRY on redemption default when attempts < max", () => {
    const r = decideRefundPolicy({
      order: mockOrder({ status: "REDEEM_DEFAULTED", redeemAttempts: 1 }),
      paidDrops: 10_100_000n,
      maxRedeemAttempts: 3,
    });
    expect(r.action).toBe("RETRY");
    expect(r.reason).toMatch(/retry/);
  });

  it("REFUND on redemption default when attempts >= max", () => {
    const r = decideRefundPolicy({
      order: mockOrder({ status: "REDEEM_DEFAULTED", redeemAttempts: 3 }),
      paidDrops: 10_100_000n,
      maxRedeemAttempts: 3,
    });
    expect(r.action).toBe("REFUND");
    expect(r.reason).toMatch(/refund/);
  });

  it("RETRY for attempt 0 default", () => {
    const r = decideRefundPolicy({
      order: mockOrder({ status: "REDEEM_DEFAULTED", redeemAttempts: 0 }),
      paidDrops: 10_100_000n,
      maxRedeemAttempts: 3,
    });
    expect(r.action).toBe("RETRY");
  });
});

describe("computeRefundAmount", () => {
  it("refunds customer payment minus sunk mint fee + operator fee", () => {
    // paid 10M, mint fee 200000, operator fee 50000 → refund 9_750_000
    expect(computeRefundAmount(10_000_000n, 200_000n, 50_000n)).toBe(9_750_000n);
  });

  it("refunds 0 when sunk fees exceed the payment", () => {
    expect(computeRefundAmount(100_000n, 200_000n, 50_000n)).toBe(0n);
  });

  it("refunds full payment when no sunk fees", () => {
    expect(computeRefundAmount(10_000_000n, 0n, 0n)).toBe(10_000_000n);
  });
});

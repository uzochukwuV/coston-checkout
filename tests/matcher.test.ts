import { describe, it, expect } from "vitest";
import { matchPaymentToOrder, isOverpayment } from "../src/checkout/matcher.js";
import type { Order } from "../src/checkout/order.js";

function mockOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "ord_1",
    merchantFlareAddress: ("0x" + "ab".repeat(20)) as `0x${string}`,
    merchantId: "m",
    settlement: "FXRP",
    tagId: 42,
    quote: {
      usdAmount: 10,
      xrpUsdPrice: 1,
      xrpUsdDecimals: 6,
      xrpAmountDrops: 10_100_000n, // 10.1 XRP (with buffer)
      minAcceptedDrops: 10_000_000n, // 10 XRP
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

function payment(overrides: Partial<{
  txHash: string;
  sourceAddress: string;
  destinationTag?: number;
  amountDrops: string;
  memoData?: string;
  ledgerIndex: number;
}> = {}) {
  return {
    txHash: "0xabc",
    sourceAddress: "rabc",
    destinationTag: 42,
    amountDrops: "10100000", // exactly xrpAmountDrops
    ledgerIndex: 1,
    ...overrides,
  };
}

describe("matchPaymentToOrder", () => {
  it("matches a correct payment to an open order", () => {
    const r = matchPaymentToOrder(payment(), [mockOrder()]);
    expect(r.matched).toBe(true);
    expect(r.order?.id).toBe("ord_1");
  });

  it("rejects payment with no destination tag", () => {
    const r = matchPaymentToOrder(payment({ destinationTag: undefined }), [mockOrder()]);
    expect(r.matched).toBe(false);
    expect(r.reason).toMatch(/no destination tag/);
  });

  it("rejects when no open order for the tag", () => {
    const r = matchPaymentToOrder(payment({ destinationTag: 999 }), [mockOrder()]);
    expect(r.matched).toBe(false);
    expect(r.reason).toMatch(/no open order/);
  });

  it("rejects when the order is not AWAITING_PAYMENT", () => {
    const r = matchPaymentToOrder(payment(), [mockOrder({ status: "SETTLING" })]);
    expect(r.matched).toBe(false);
  });

  it("rejects underpayment (below minAcceptedDrops)", () => {
    const r = matchPaymentToOrder(
      payment({ amountDrops: "5000000" }), // 5 XRP < 10 XRP min
      [mockOrder()],
    );
    expect(r.matched).toBe(false);
    expect(r.reason).toMatch(/underpaid/);
  });

  it("accepts exact minAcceptedDrops", () => {
    const r = matchPaymentToOrder(
      payment({ amountDrops: "10000000" }),
      [mockOrder()],
    );
    expect(r.matched).toBe(true);
  });

  it("accepts overpayment (credits merchant)", () => {
    const r = matchPaymentToOrder(
      payment({ amountDrops: "20000000" }), // 20 XRP > 10.1
      [mockOrder()],
    );
    expect(r.matched).toBe(true);
  });

  it("rejects expired orders", () => {
    const expired = mockOrder({
      quote: { ...mockOrder().quote, expiresAt: 1 },
    });
    const r = matchPaymentToOrder(payment(), [expired], 2000);
    expect(r.matched).toBe(false);
    expect(r.reason).toMatch(/expired/);
  });

  it("matches the right order among many by tag", () => {
    const orders = [mockOrder({ id: "a", tagId: 1 }), mockOrder({ id: "b", tagId: 2 })];
    const r = matchPaymentToOrder(payment({ destinationTag: 2 }), orders);
    expect(r.matched).toBe(true);
    expect(r.order?.id).toBe("b");
  });
});

describe("isOverpayment", () => {
  it("true when paid > xrpAmountDrops", () => {
    expect(isOverpayment(payment({ amountDrops: "11000000" }), mockOrder())).toBe(true);
  });
  it("false when paid <= xrpAmountDrops", () => {
    expect(isOverpayment(payment({ amountDrops: "10100000" }), mockOrder())).toBe(false);
    expect(isOverpayment(payment({ amountDrops: "10000000" }), mockOrder())).toBe(false);
  });
});

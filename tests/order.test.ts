import { describe, it, expect } from "vitest";
import {
  computeQuote,
  canTransition,
  transition,
  isQuoteLive,
  type Order,
  type OrderStatus,
} from "../src/checkout/order.js";
import type { FeedResult } from "../src/chain/ftso.js";

function mockFeed(value: bigint, decimals = 6, stale = false): FeedResult {
  return { value, decimals, timestamp: Math.floor(Date.now() / 1000), stale };
}

describe("computeQuote", () => {
  it("converts USD → XRP drops using the FTSO price", () => {
    // XRP/USD = 1.00 (value=1000000, decimals=6) → 1 USD = 1 XRP = 1e6 drops
    const q = computeQuote({
      usdAmount: 10,
      xrpUsd: mockFeed(1_000_000n, 6),
      slippageBps: 0,
      serviceFeeBps: 0,
    });
    expect(q.xrpAmountDrops).toBe(10_000_000n); // 10 XRP
    expect(q.minAcceptedDrops).toBe(10_000_000n);
  });

  it("applies service fee on top (merchant not shorted)", () => {
    // 1% service fee: customer pays 1/0.99 ≈ 1.0101x
    const q = computeQuote({
      usdAmount: 100,
      xrpUsd: mockFeed(1_000_000n, 6),
      slippageBps: 0,
      serviceFeeBps: 100, // 1%
    });
    // base = 100e6; withFee = base * 10000/(10000-100) = base * 10000/9900
    const expectedWithFee = (100_000_000n * 10_000n) / 9_900n;
    expect(q.xrpAmountDrops).toBe(expectedWithFee);
    expect(q.minAcceptedDrops).toBe(100_000_000n); // base unchanged
  });

  it("applies slippage buffer on top of fee", () => {
    const q = computeQuote({
      usdAmount: 50,
      xrpUsd: mockFeed(500_000n, 6), // 0.5 USD per XRP → 100 XRP for $50
      slippageBps: 200, // 2%
      serviceFeeBps: 0,
    });
    const base = 100_000_000n; // 100 XRP
    const expected = (base * 10_200n) / 10_000n;
    expect(q.xrpAmountDrops).toBe(expected);
  });

  it("handles non-6-decimals price feeds", () => {
    // XRP/USD = 2.00 with decimals=8 → value=200000000
    const q = computeQuote({
      usdAmount: 20,
      xrpUsd: mockFeed(200_000_000n, 8), // 2.00
      slippageBps: 0,
      serviceFeeBps: 0,
    });
    // 20 USD / 2 = 10 XRP = 10e6 drops
    expect(q.xrpAmountDrops).toBe(10_000_000n);
  });

  it("rejects zero/USD", () => {
    expect(() =>
      computeQuote({ usdAmount: 0, xrpUsd: mockFeed(1_000_000n, 6) }),
    ).toThrow();
  });

  it("rejects stale price feed", () => {
    expect(() =>
      computeQuote({ usdAmount: 10, xrpUsd: mockFeed(1_000_000n, 6, true) }),
    ).toThrow(/stale/);
  });

  it("rejects zero price", () => {
    expect(() =>
      computeQuote({ usdAmount: 10, xrpUsd: mockFeed(0n, 6) }),
    ).toThrow(/positive/);
  });

  it("sets a future expiry", () => {
    const before = Math.floor(Date.now() / 1000);
    const q = computeQuote({
      usdAmount: 1,
      xrpUsd: mockFeed(1_000_000n, 6),
      expirySeconds: 600,
    });
    expect(q.expiresAt).toBeGreaterThanOrEqual(before + 599);
  });
});

describe("order state machine", () => {
  function mockOrder(status: OrderStatus): Order {
    return {
      id: "ord_test",
      merchantFlareAddress: ("0x" + "00".repeat(20)) as `0x${string}`,
      merchantId: "m",
      settlement: "FXRP",
      quote: {
        usdAmount: 10,
        xrpUsdPrice: 1,
        xrpUsdDecimals: 6,
        xrpAmountDrops: 10_000_000n,
        minAcceptedDrops: 10_000_000n,
        slippageBps: 0,
        serviceFeeBps: 0,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        createdAt: Math.floor(Date.now() / 1000),
      },
      status,
      createdAt: Math.floor(Date.now() / 1000),
    };
  }

  it("allows CREATED → AWAITING_PAYMENT", () => {
    expect(canTransition("CREATED", "AWAITING_PAYMENT")).toBe(true);
  });
  it("allows AWAITING_PAYMENT → PAYMENT_DETECTED", () => {
    expect(canTransition("AWAITING_PAYMENT", "PAYMENT_DETECTED")).toBe(true);
  });
  it("allows PAYMENT_DETECTED → SETTLING", () => {
    expect(canTransition("PAYMENT_DETECTED", "SETTLING")).toBe(true);
  });
  it("allows SETTLING → SETTLED", () => {
    expect(canTransition("SETTLING", "SETTLED")).toBe(true);
  });
  it("allows terminal exits (EXPIRED, FAILED)", () => {
    expect(canTransition("CREATED", "EXPIRED")).toBe(true);
    expect(canTransition("AWAITING_PAYMENT", "FAILED")).toBe(true);
  });
  it("forbids backwards transitions", () => {
    expect(canTransition("SETTLED", "SETTLING")).toBe(false);
    expect(canTransition("SETTLED", "AWAITING_PAYMENT")).toBe(false);
  });
  it("forbids transitions from terminal states", () => {
    expect(canTransition("SETTLED", "FAILED")).toBe(false);
    expect(canTransition("EXPIRED", "SETTLED")).toBe(false);
    expect(canTransition("FAILED", "SETTLED")).toBe(false);
  });

  // --- Flow B (settle-to-XRP) transitions ---
  it("allows SETTLING → MINTED (Flow B)", () => {
    expect(canTransition("SETTLING", "MINTED")).toBe(true);
  });
  it("allows SETTLING → SETTLED (Flow A)", () => {
    expect(canTransition("SETTLING", "SETTLED")).toBe(true);
  });
  it("allows MINTED → REDEEMING", () => {
    expect(canTransition("MINTED", "REDEEMING")).toBe(true);
  });
  it("allows REDEEMING → REDEEMED", () => {
    expect(canTransition("REDEEMING", "REDEEMED")).toBe(true);
  });
  it("allows REDEEMING → REDEEM_DEFAULTED", () => {
    expect(canTransition("REDEEMING", "REDEEM_DEFAULTED")).toBe(true);
  });
  it("allows REDEEM_DEFAULTED → REDEEMING (retry)", () => {
    expect(canTransition("REDEEM_DEFAULTED", "REDEEMING")).toBe(true);
  });
  it("allows REDEEM_DEFAULTED → REFUNDED", () => {
    expect(canTransition("REDEEM_DEFAULTED", "REFUNDED")).toBe(true);
  });
  it("REDEEMED is terminal", () => {
    expect(canTransition("REDEEMED", "REDEEMING")).toBe(false);
    expect(canTransition("REDEEMED", "FAILED")).toBe(false);
  });
  it("REFUNDED is terminal", () => {
    expect(canTransition("REFUNDED", "AWAITING_PAYMENT")).toBe(false);
  });
  it("forbids SETTLING → REDEEMING (must go through MINTED)", () => {
    expect(canTransition("SETTLING", "REDEEMING")).toBe(false);
  });
  it("transition() applies patches", () => {
    const o = mockOrder("PAYMENT_DETECTED");
    const updated = transition(o, "SETTLING", { matchedTxHash: "0xabc" });
    expect(updated.status).toBe("SETTLING");
    expect(updated.matchedTxHash).toBe("0xabc");
  });
  it("transition() throws on invalid transitions", () => {
    const o = mockOrder("SETTLED");
    expect(() => transition(o, "AWAITING_PAYMENT")).toThrow(/Invalid transition/);
  });
});

describe("isQuoteLive", () => {
  it("returns true before expiry", () => {
    const now = 1000;
    const q = { expiresAt: 2000 } as any;
    expect(isQuoteLive(q, now)).toBe(true);
  });
  it("returns false at/after expiry", () => {
    expect(isQuoteLive({ expiresAt: 1000 } as any, 1000)).toBe(false);
    expect(isQuoteLive({ expiresAt: 1000 } as any, 1001)).toBe(false);
  });
});

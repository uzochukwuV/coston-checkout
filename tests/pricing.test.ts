import { describe, it, expect } from "vitest";
import { priceOrder, isRedeemable } from "../src/checkout/pricing.js";
import type { FeeParams } from "../src/chain/asset-manager.js";

function mockFees(overrides: Partial<FeeParams> = {}): FeeParams {
  return {
    mintFeeBIPS: 25n, // 0.25%
    mintMinimumFeeUBA: 100_000n, // 0.1 XRP floor
    executorFeeUBA: 100_000n,
    redeemFeeBIPS: 10n, // 0.1%
    minimumRedeemAmountUBA: 1_000_000n, // 1 XRP min redeem
    ...overrides,
  };
}

describe("priceOrder — Flow A (settle-to-FXRP)", () => {
  it("deducts the mint fee and gives the rest to the merchant as FXRP", () => {
    // customer pays 10 XRP = 10_000_000 drops
    const { breakdown, merchantProtected } = priceOrder({
      customerXrpDrops: 10_000_000n,
      fees: mockFees(),
      operatorFeeBps: 50n, // 0.5%
      settlement: "FXRP",
    });
    // mintFeeBIPS 25 = 0.25% of 10M = 25000; min floor 100000 > 25000 → use floor 100000
    // executorFee 100000
    // totalMintFee = 200000; fxrpMinted = 9_800_000
    expect(breakdown.mintFeeDrops).toBe(200_000n);
    expect(breakdown.fxrpMintedDrops).toBe(9_800_000n);
    expect(breakdown.merchantFxrpDrops).toBe(9_800_000n);
    expect(breakdown.redeemFeeDrops).toBe(0n); // Flow A
    expect(breakdown.merchantXrpDrops).toBe(0n); // Flow A
    expect(merchantProtected).toBe(true);
  });

  it("uses the percentage fee when it exceeds the minimum floor", () => {
    // large amount: 100 XRP; 0.25% = 250000 drops > 100000 floor
    const { breakdown } = priceOrder({
      customerXrpDrops: 100_000_000n,
      fees: mockFees(),
      operatorFeeBps: 50n,
      settlement: "FXRP",
    });
    expect(breakdown.mintFeeDrops).toBe(350_000n); // 250000 + 100000 executor
    expect(breakdown.merchantFxrpDrops).toBe(99_650_000n);
  });

  it("reduces the executor fee when funds are insufficient", () => {
    // tiny payment: 150000 drops; mint fee floor 100000; executor fee 100000 → only 50000 left
    const { breakdown } = priceOrder({
      customerXrpDrops: 150_000n,
      fees: mockFees(),
      operatorFeeBps: 50n,
      settlement: "FXRP",
    });
    expect(breakdown.mintFeeDrops).toBe(150_000n); // 100000 mint + 50000 executor (reduced)
    expect(breakdown.merchantFxrpDrops).toBe(0n);
  });

  it("records the operator service fee (from the customer's buffer)", () => {
    const { breakdown } = priceOrder({
      customerXrpDrops: 10_000_000n,
      fees: mockFees(),
      operatorFeeBps: 50n,
      settlement: "FXRP",
    });
    expect(breakdown.operatorFeeDrops).toBe(50_000n); // 0.5% of 10M
  });
});

describe("priceOrder — Flow B (settle-to-XRP)", () => {
  it("deducts mint + redeem + operator fees; merchant receives XRP", () => {
    const { breakdown, merchantProtected } = priceOrder({
      customerXrpDrops: 10_000_000n,
      fees: mockFees(),
      operatorFeeBps: 50n,
      settlement: "XRP",
    });
    // fxrpMinted = 9_800_000 (same as Flow A)
    // redeemFee = 0.1% of 9_800_000 = 9800
    // operatorFee = 0.5% of 9_800_000 = 49000
    // merchantXrp = 9_800_000 - 9800 - 49000 = 9_741_200
    expect(breakdown.merchantFxrpDrops).toBe(0n); // Flow B: not FXRP
    expect(breakdown.redeemFeeDrops).toBe(9_800n);
    expect(breakdown.operatorFeeDrops).toBe(49_000n);
    expect(breakdown.merchantXrpDrops).toBe(9_741_200n);
    expect(merchantProtected).toBe(true);
  });

  it("Flow B merchant receives less than Flow A (extra redeem fee)", () => {
    const flowA = priceOrder({
      customerXrpDrops: 10_000_000n,
      fees: mockFees(),
      operatorFeeBps: 50n,
      settlement: "FXRP",
    });
    const flowB = priceOrder({
      customerXrpDrops: 10_000_000n,
      fees: mockFees(),
      operatorFeeBps: 50n,
      settlement: "XRP",
    });
    expect(flowB.breakdown.merchantXrpDrops).toBeLessThan(flowA.breakdown.merchantFxrpDrops);
  });

  it("merchantProtected is false when fees consume the whole amount", () => {
    const { breakdown, merchantProtected } = priceOrder({
      customerXrpDrops: 150_000n, // barely covers mint fee
      fees: mockFees(),
      operatorFeeBps: 50n,
      settlement: "XRP",
    });
    expect(breakdown.merchantXrpDrops).toBe(0n);
    expect(merchantProtected).toBe(false);
  });
});

describe("isRedeemable", () => {
  it("true when amount >= minimum", () => {
    expect(isRedeemable(1_000_000n, 1_000_000n)).toBe(true);
    expect(isRedeemable(2_000_000n, 1_000_000n)).toBe(true);
  });
  it("false when amount < minimum", () => {
    expect(isRedeemable(999_999n, 1_000_000n)).toBe(false);
  });
});

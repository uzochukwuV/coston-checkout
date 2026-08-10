import { describe, it, expect } from "vitest";
import { OrderStore } from "../src/checkout/order-store.js";
import type { Order } from "../src/checkout/order.js";

function mockOrder(id: string, tagId?: number, status: Order["status"] = "AWAITING_PAYMENT"): Order {
  return {
    id,
    merchantFlareAddress: ("0x" + "00".repeat(20)) as `0x${string}`,
    merchantId: "m",
    settlement: "FXRP",
    tagId,
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

describe("OrderStore", () => {
  it("saves and gets by id", () => {
    const store = new OrderStore();
    store.save(mockOrder("ord_1", 42));
    expect(store.get("ord_1")?.id).toBe("ord_1");
  });

  it("gets by tag", () => {
    const store = new OrderStore();
    store.save(mockOrder("ord_1", 42));
    expect(store.getByTag(42)?.id).toBe("ord_1");
    expect(store.getByTag(99)).toBeUndefined();
  });

  it("lists open (AWAITING_PAYMENT) orders", () => {
    const store = new OrderStore();
    store.save(mockOrder("ord_1", 1, "AWAITING_PAYMENT"));
    store.save(mockOrder("ord_2", 2, "SETTLED"));
    store.save(mockOrder("ord_3", 3, "AWAITING_PAYMENT"));
    expect(store.listOpen().length).toBe(2);
  });

  it("lists all orders", () => {
    const store = new OrderStore();
    store.save(mockOrder("ord_1", 1));
    store.save(mockOrder("ord_2", 2));
    expect(store.listAll().length).toBe(2);
  });

  it("deletes by id and clears tag index", () => {
    const store = new OrderStore();
    store.save(mockOrder("ord_1", 42));
    store.delete("ord_1");
    expect(store.get("ord_1")).toBeUndefined();
    expect(store.getByTag(42)).toBeUndefined();
  });

  it("updates an existing order (save overwrites)", () => {
    const store = new OrderStore();
    store.save(mockOrder("ord_1", 42, "AWAITING_PAYMENT"));
    store.save(mockOrder("ord_1", 42, "SETTLED"));
    expect(store.get("ord_1")?.status).toBe("SETTLED");
  });
});

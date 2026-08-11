import { describe, it, expect } from "vitest";
import { SqliteOrderStore } from "../src/checkout/order-store-sqlite.js";
import type { Order } from "../src/checkout/order.js";

function mockOrder(
  id: string,
  tagId?: number,
  status: Order["status"] = "AWAITING_PAYMENT",
): Order {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    merchantFlareAddress: ("0x" + "00".repeat(20)) as `0x${string}`,
    merchantId: "m",
    settlement: "FXRP",
    tagId,
    quote: {
      usdAmount: 10,
      xrpUsdPrice: 1.0,
      xrpUsdDecimals: 6,
      xrpAmountDrops: 10_000_000n,
      minAcceptedDrops: 10_000_000n,
      slippageBps: 0,
      serviceFeeBps: 0,
      expiresAt: now + 600,
      createdAt: now,
    },
    status,
    createdAt: now,
  };
}

describe("SqliteOrderStore", () => {
  it("saves and gets by id (in-memory db)", () => {
    const store = new SqliteOrderStore(":memory:");
    store.save(mockOrder("ord_1", 42));
    expect(store.get("ord_1")?.id).toBe("ord_1");
    store.close();
  });

  it("round-trips BigInt fields losslessly", () => {
    const store = new SqliteOrderStore(":memory:");
    const order = mockOrder("ord_big", 7);
    order.quote.xrpAmountDrops = 1234567890n;
    order.feeBreakdown = {
      customerXrpDrops: 10000000n,
      mintFeeDrops: 25000n,
      fxrpMintedDrops: 9975000n,
      redeemFeeDrops: 0n,
      operatorFeeDrops: 5000n,
      merchantFxrpDrops: 9975000n,
      merchantXrpDrops: 0n,
    };
    store.save(order);
    const got = store.get("ord_big")!;
    expect(got.quote.xrpAmountDrops).toBe(1234567890n);
    expect(got.feeBreakdown?.fxrpMintedDrops).toBe(9975000n);
    expect(typeof got.quote.xrpAmountDrops).toBe("bigint");
    store.close();
  });

  it("gets by tag", () => {
    const store = new SqliteOrderStore(":memory:");
    store.save(mockOrder("ord_1", 42));
    expect(store.getByTag(42)?.id).toBe("ord_1");
    expect(store.getByTag(99)).toBeUndefined();
    store.close();
  });

  it("lists open (AWAITING_PAYMENT) orders", () => {
    const store = new SqliteOrderStore(":memory:");
    store.save(mockOrder("ord_1", 1, "AWAITING_PAYMENT"));
    store.save(mockOrder("ord_2", 2, "SETTLED"));
    store.save(mockOrder("ord_3", 3, "AWAITING_PAYMENT"));
    expect(store.listOpen().length).toBe(2);
    store.close();
  });

  it("lists all orders", () => {
    const store = new SqliteOrderStore(":memory:");
    store.save(mockOrder("ord_1", 1));
    store.save(mockOrder("ord_2", 2));
    expect(store.listAll().length).toBe(2);
    store.close();
  });

  it("deletes by id", () => {
    const store = new SqliteOrderStore(":memory:");
    store.save(mockOrder("ord_1", 42));
    store.delete("ord_1");
    expect(store.get("ord_1")).toBeUndefined();
    store.close();
  });

  it("updates an existing order (save overwrites)", () => {
    const store = new SqliteOrderStore(":memory:");
    store.save(mockOrder("ord_1", 42, "AWAITING_PAYMENT"));
    store.save(mockOrder("ord_1", 42, "SETTLED"));
    expect(store.get("ord_1")?.status).toBe("SETTLED");
    store.close();
  });

  it("persists across store instances on the same file", () => {
    const path = `/tmp/fxrp_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`;
    const s1 = new SqliteOrderStore(path);
    s1.save(mockOrder("ord_persist", 77));
    s1.close();
    // open a new connection to the same file — data must survive
    const s2 = new SqliteOrderStore(path);
    expect(s2.get("ord_persist")?.id).toBe("ord_persist");
    expect(s2.getByTag(77)?.id).toBe("ord_persist");
    s2.close();
  });
});

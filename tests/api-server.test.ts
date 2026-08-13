/**
 * Smoke test the HTTP API server: start it, hit /healthz, create an order,
 * read it back, then shut down. Uses a stubbed CheckoutService (no chain).
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { createApiServer } from "../src/api/server.js";
import type { CheckoutService } from "../src/checkout/checkout-service.js";
import type { Order } from "../src/checkout/order.js";

// Minimal stub: only the methods the API uses, returning canned data.
function stubService(order: Order): CheckoutService {
  return {
    createOrder: async () => order,
    getOrder: (id: string) => (id === order.id ? order : undefined),
    listOpen: () => [order],
    listAll: () => [order],
    pollAndMatch: async () => [],
    expireStale: () => [],
  } as unknown as CheckoutService;
}

const order: Order = {
  id: "ord_smoke",
  merchantFlareAddress: ("0x" + "00".repeat(20)) as `0x${string}`,
  merchantId: "m",
  settlement: "FXRP",
  quote: {
    usdAmount: 5,
    xrpUsdPrice: 1,
    xrpUsdDecimals: 6,
    xrpAmountDrops: 5_000_000n,
    minAcceptedDrops: 5_000_000n,
    slippageBps: 0,
    serviceFeeBps: 0,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    createdAt: Math.floor(Date.now() / 1000),
  },
  status: "AWAITING_PAYMENT",
  createdAt: Math.floor(Date.now() / 1000),
};

describe("HTTP API server", () => {
  let server: ReturnType<typeof createApiServer>;
  let base: string;

  beforeAll(async () => {
    server = createApiServer(stubService(order), { port: 0, polling: { enabled: false } });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 3000;
        base = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }, 15000);

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("GET /healthz returns ok", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.ok).toBe(true);
  });

  it("POST /orders creates an order", async () => {
    const r = await fetch(`${base}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usdAmount: 5 }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as any;
    expect(body.id).toBe("ord_smoke");
  });

  it("POST /orders rejects bad input", async () => {
    const r = await fetch(`${base}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  it("GET /orders/:id returns the order", async () => {
    const r = await fetch(`${base}/orders/ord_smoke`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.id).toBe("ord_smoke");
  });

  it("GET /orders/:id 404s for unknown", async () => {
    const r = await fetch(`${base}/orders/nope`);
    expect(r.status).toBe(404);
  });

  it("GET /orders lists orders", async () => {
    const r = await fetch(`${base}/orders`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
  });

  it("POST /admin/poll runs (empty)", async () => {
    const r = await fetch(`${base}/admin/poll`, { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.settled).toBe(0);
  });
});

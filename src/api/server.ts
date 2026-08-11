/**
 * Minimal HTTP API for the merchant checkout.
 *
 * Endpoints:
 *   GET  /healthz                    → liveness
 *   POST /orders                     → create an order { usdAmount }
 *   GET  /orders/:id                 → order status + quote
 *   GET  /orders                     → list all orders (debug)
 *   POST /admin/poll                 → trigger a payment poll+match cycle (debug)
 *   POST /admin/expire               → expire stale orders (debug)
 *
 * No framework dependency — uses node:http. Business logic lives in
 * CheckoutService; this is a thin transport layer.
 *
 * A background PollingLoop runs alongside the server so settlement happens
 * automatically (no manual /admin/poll needed). The loop polls XRPL for Core
 * Vault payments, matches them to open orders, and settles via FDC proofs.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { CheckoutService } from "../checkout/checkout-service.js";
import { PollingLoop, type PollingLoopOptions } from "../checkout/polling-loop.js";

export interface ApiServerOptions {
  port?: number;
  /** Polling loop config; pass `{ enabled: false }` to disable auto-settlement. */
  polling?: PollingLoopOptions & { enabled?: boolean };
}

export function createApiServer(svc: CheckoutService, opts: ApiServerOptions = {}) {
  const port = opts.port ?? 3000;
  let pollingLoop: PollingLoop | undefined;

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    });
  });

  server.on("close", () => {
    pollingLoop?.stop();
  });

  const pollEnabled = opts.polling?.enabled !== false;
  if (pollEnabled) {
    pollingLoop = new PollingLoop(svc, {
      intervalMs: opts.polling?.intervalMs ?? 5000,
      initialDelayMs: opts.polling?.initialDelayMs,
      onError: opts.polling?.onError ?? ((e, cycle) => console.error(`[poll #${cycle}]`, e.message)),
      onCycle: opts.polling?.onCycle,
    });
    pollingLoop.start();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (code: number, body: unknown): void => {
      if (res.headersSent) return;
      res.writeHead(code, { "Content-Type": "application/json" });
      // Orders carry BigInt amounts; serialize as strings.
      res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    };

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;

    if (req.method === "GET" && path === "/healthz") {
      return send(200, { ok: true });
    }

    if (req.method === "POST" && path === "/orders") {
      const body = await readJsonBody(req);
      if (typeof body.usdAmount !== "number" || body.usdAmount <= 0) {
        return send(400, { error: "usdAmount (number > 0) required" });
      }
      const order = await svc.createOrder({ usdAmount: body.usdAmount });
      return send(201, order);
    }

    if (req.method === "GET" && path === "/orders") {
      return send(200, svc.listOpen());
    }

    const orderMatch = path.match(/^\/orders\/(.+)$/);
    if (req.method === "GET" && orderMatch) {
      const order = svc.getOrder(orderMatch[1]);
      if (!order) return send(404, { error: "not found" });
      return send(200, order);
    }

    if (req.method === "POST" && path === "/admin/poll") {
      await drainBody(req);
      const settled = await svc.pollAndMatch();
      return send(200, { settled: settled.length, orders: settled });
    }

    if (req.method === "POST" && path === "/admin/expire") {
      await drainBody(req);
      const expired = svc.expireStale();
      return send(200, { expired: expired.length });
    }

    return send(404, { error: "not found" });
  }

  return server;
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer | string) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** Drain the request body so the connection can be reused (for routes that ignore it). */
function drainBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    req.on("data", () => {});
    req.on("end", () => resolve());
    req.on("error", () => resolve());
  });
}

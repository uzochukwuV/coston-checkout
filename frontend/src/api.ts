/**
 * API client — thin typed wrapper over the backend REST endpoints.
 *
 * In dev, Vite proxies /api → http://localhost:3000 (see vite.config.ts), and
 * the proxy strips the /api prefix before forwarding.
 * In production, set VITE_API_BASE to the backend URL (no trailing /api).
 */

import type { Order, CreateOrderRequest } from "./types";

const BASE = import.meta.env.VITE_API_BASE ?? "";
// Dev: "/api/orders" → Vite proxy strips /api → backend /orders
// Prod: BASE + "/orders" → backend /orders directly
const PREFIX = BASE ? BASE : "/api";

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${PREFIX}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const text = await resp.text();
  const json = text ? JSON.parse(text) : null;
  if (!resp.ok) {
    throw new ApiError(resp.status, json?.error ?? resp.statusText);
  }
  return json as T;
}

export const api = {
  createOrder: (body: CreateOrderRequest) =>
    request<Order>("/orders", { method: "POST", body: JSON.stringify(body) }),

  getOrder: (id: string) => request<Order>(`/orders/${id}`),

  listOrders: () => request<Order[]>("/orders"),

  healthz: () => request<{ ok: boolean }>("/healthz"),

  pollOnce: () => request<{ settled: number; orders: Order[] }>("/admin/poll", { method: "POST" }),

  expire: () => request<{ expired: number }>("/admin/expire", { method: "POST" }),
};

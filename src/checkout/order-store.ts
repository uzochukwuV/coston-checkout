/**
 * In-memory order store. For v1/MVP this is a Map; Phase 4 swaps for a real DB.
 * Pure logic, no network.
 */

import type { Order } from "./order.js";

export class OrderStore {
  private orders = new Map<string, Order>();
  private byTag = new Map<number, string>(); // tagId → orderId

  save(order: Order): void {
    this.orders.set(order.id, order);
    if (order.tagId !== undefined) {
      this.byTag.set(order.tagId, order.id);
    }
  }

  get(id: string): Order | undefined {
    return this.orders.get(id);
  }

  getByTag(tagId: number): Order | undefined {
    const id = this.byTag.get(tagId);
    return id ? this.orders.get(id) : undefined;
  }

  /** All orders in a given status (e.g. all AWAITING_PAYMENT for the watcher). */
  listOpen(status: Order["status"] = "AWAITING_PAYMENT"): Order[] {
    return Array.from(this.orders.values()).filter((o) => o.status === status);
  }

  listAll(): Order[] {
    return Array.from(this.orders.values());
  }

  delete(id: string): void {
    const o = this.orders.get(id);
    if (o?.tagId !== undefined) this.byTag.delete(o.tagId);
    this.orders.delete(id);
  }
}

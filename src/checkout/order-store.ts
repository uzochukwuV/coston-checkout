/**
 * Order persistence interface — implemented by the in-memory OrderStore and the
 * SQLite-backed SqliteOrderStore. The service accepts either.
 */
import type { Order } from "./order.js";

export interface IOrderStore {
  save(order: Order): void;
  get(id: string): Order | undefined;
  getByTag(tagId: number): Order | undefined;
  listOpen(status?: Order["status"]): Order[];
  listAll(): Order[];
  delete(id: string): void;
}

/**
 * In-memory order store. For tests and quick demos.
 * Pure logic, no network.
 */

export class OrderStore implements IOrderStore {
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

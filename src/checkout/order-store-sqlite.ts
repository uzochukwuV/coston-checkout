/**
 * SQLite-backed persistent order store.
 *
 * Drop-in replacement for the in-memory OrderStore: same method surface
 * (save / get / getByTag / listOpen / listAll / delete). The full Order object
 * is serialized as JSON in a `data` column; `id`, `status`, and `tag_id` are
 * promoted to indexed columns for fast lookups.
 *
 * BigInt values survive the round-trip via a JSON reviver that converts
 * {"__bigint":"123n"} markers back to BigInt (see serialize/deserialize below).
 *
 * The store is synchronous (better-sqlite3 is sync) — matching the original
 * in-memory API, so CheckoutService needs no async changes.
 */

import Database from "better-sqlite3";
import type { Order } from "./order.js";
import type { IOrderStore } from "./order-store.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id       TEXT PRIMARY KEY,
  status   TEXT NOT NULL,
  tag_id   INTEGER,
  data     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_tag_id  ON orders (tag_id);
`;

// JSON replacer: BigInt → { "__bigint": "<value>n" }
function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? { __bigint: v.toString() } : v;
}

function bigintReviver(_k: string, v: unknown): unknown {
  if (v && typeof v === "object" && "__bigint" in v) {
    return BigInt((v as { __bigint: string }).__bigint);
  }
  return v;
}

function serialize(order: Order): string {
  return JSON.stringify(order, bigintReplacer);
}

function deserialize(json: string): Order {
  return JSON.parse(json, bigintReviver) as Order;
}

export class SqliteOrderStore implements IOrderStore {
  private db: Database.Database;
  private stmts: {
    insert: Database.Statement;
    selectById: Database.Statement;
    selectByTag: Database.Statement;
    selectByStatus: Database.Statement;
    selectAll: Database.Statement;
    deleteById: Database.Statement;
  };

  constructor(dbPath = "orders.db") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.stmts = {
      insert: this.db.prepare(
        "INSERT OR REPLACE INTO orders (id, status, tag_id, data) VALUES (@id, @status, @tag_id, @data)",
      ),
      selectById: this.db.prepare("SELECT data FROM orders WHERE id = ?"),
      selectByTag: this.db.prepare("SELECT data FROM orders WHERE tag_id = ?"),
      selectByStatus: this.db.prepare("SELECT data FROM orders WHERE status = ?"),
      selectAll: this.db.prepare("SELECT data FROM orders"),
      deleteById: this.db.prepare("DELETE FROM orders WHERE id = ?"),
    };
  }

  save(order: Order): void {
    this.stmts.insert.run({
      id: order.id,
      status: order.status,
      tag_id: order.tagId ?? null,
      data: serialize(order),
    });
  }

  get(id: string): Order | undefined {
    const row = this.stmts.selectById.get(id) as { data: string } | undefined;
    return row ? deserialize(row.data) : undefined;
  }

  getByTag(tagId: number): Order | undefined {
    const row = this.stmts.selectByTag.get(tagId) as { data: string } | undefined;
    return row ? deserialize(row.data) : undefined;
  }

  listOpen(status: Order["status"] = "AWAITING_PAYMENT"): Order[] {
    const rows = this.stmts.selectByStatus.all(status) as { data: string }[];
    return rows.map((r) => deserialize(r.data));
  }

  listAll(): Order[] {
    const rows = this.stmts.selectAll.all() as { data: string }[];
    return rows.map((r) => deserialize(r.data));
  }

  delete(id: string): void {
    this.stmts.deleteById.run(id);
  }

  close(): void {
    this.db.close();
  }
}

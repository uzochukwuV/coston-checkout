import { describe, it, expect } from "vitest";
import { TagPool } from "../src/checkout/tag-pool.js";

const RECIPIENT = "0x" + "ab".repeat(20) as `0x${string}`;
const OTHER = "0x" + "cd".repeat(20) as `0x${string}`;

describe("TagPool", () => {
  it("adds reserved tags", () => {
    const pool = new TagPool();
    pool.addReserved({ tagId: 1, ownerAddress: "0x1", boundRecipient: RECIPIENT, available: true });
    expect(pool.totalCount()).toBe(1);
    expect(pool.availableCount()).toBe(1);
  });

  it("allocates a free tag to an order", () => {
    const pool = new TagPool();
    pool.addReserved({ tagId: 1, ownerAddress: "0x1", boundRecipient: RECIPIENT, available: true });
    pool.addReserved({ tagId: 2, ownerAddress: "0x1", boundRecipient: RECIPIENT, available: true });
    const tagId = pool.allocate("ord_1", RECIPIENT);
    expect(tagId).toBe(1);
    expect(pool.availableCount()).toBe(1);
  });

  it("throws when no free tags", () => {
    const pool = new TagPool();
    expect(() => pool.allocate("ord_1", RECIPIENT)).toThrow(/no free tags/);
  });

  it("only allocates tags bound to the requested recipient", () => {
    const pool = new TagPool();
    pool.addReserved({ tagId: 1, ownerAddress: "0x1", boundRecipient: OTHER, available: true });
    expect(() => pool.allocate("ord_1", RECIPIENT)).toThrow(/no free tags/);
  });

  it("releases a tag back to the pool", () => {
    const pool = new TagPool();
    pool.addReserved({ tagId: 1, ownerAddress: "0x1", boundRecipient: RECIPIENT, available: true });
    pool.allocate("ord_1", RECIPIENT);
    expect(pool.availableCount()).toBe(0);
    pool.release(1);
    expect(pool.availableCount()).toBe(1);
  });

  it("does not re-add an existing tag", () => {
    const pool = new TagPool();
    pool.addReserved({ tagId: 1, ownerAddress: "0x1", boundRecipient: RECIPIENT, available: true });
    expect(() =>
      pool.addReserved({ tagId: 1, ownerAddress: "0x1", boundRecipient: RECIPIENT, available: true }),
    ).toThrow(/already in pool/);
  });

  it("allocates across multiple recipients independently", () => {
    const pool = new TagPool();
    pool.addReserved({ tagId: 1, ownerAddress: "0x1", boundRecipient: RECIPIENT, available: true });
    pool.addReserved({ tagId: 2, ownerAddress: "0x2", boundRecipient: OTHER, available: true });
    expect(pool.allocate("ord_a", RECIPIENT)).toBe(1);
    expect(pool.allocate("ord_b", OTHER)).toBe(2);
    expect(pool.availableCount(RECIPIENT)).toBe(0);
    expect(pool.availableCount(OTHER)).toBe(0);
  });
});

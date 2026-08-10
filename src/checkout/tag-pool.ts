/**
 * MintingTagManager tag pool.
 *
 * The 32-byte direct-minting memo has no room for an orderId, so a MintingTagManager
 * tag (XRPL destination tag) is the order binding. Tags are reusable NFTs; we
 * maintain a pool and allocate/rotate them per order.
 *
 * Allocation logic is pure (unit-tested). The on-chain reserve/bind writes are in
 * the TagManagerWriter (DRY_RUN-guarded). 10-min cooldown on setMintingRecipient
 * means we pre-bind tags to a merchant address and rotate, not rebind per order.
 */

export interface PooledTag {
  tagId: number;
  ownerAddress: string;
  boundRecipient: `0x${string}`;
  allocatedOrderId?: string;
  available: boolean;
}

export class TagPool {
  private tags: PooledTag[] = [];

  /** Add an already-reserved tag (from the on-chain writer) to the pool. */
  addReserved(tag: PooledTag): void {
    if (this.tags.some((t) => t.tagId === tag.tagId)) {
      throw new Error(`tag ${tag.tagId} already in pool`);
    }
    this.tags.push({ ...tag });
  }

  /** Allocate an available tag to an order. Returns the tagId, or throws if exhausted. */
  allocate(orderId: string, recipient: `0x${string}`): number {
    const free = this.tags.find((t) => t.available && t.boundRecipient === recipient);
    if (!free) {
      throw new Error(`no free tags bound to ${recipient}; reserve more`);
    }
    free.available = false;
    free.allocatedOrderId = orderId;
    return free.tagId;
  }

  /** Release a tag back to the pool (after settlement or expiry). */
  release(tagId: number): void {
    const tag = this.tags.find((t) => t.tagId === tagId);
    if (!tag) return;
    tag.available = true;
    tag.allocatedOrderId = undefined;
  }

  availableCount(recipient?: `0x${string}`): number {
    return this.tags.filter(
      (t) => t.available && (!recipient || t.boundRecipient === recipient),
    ).length;
  }

  totalCount(): number {
    return this.tags.length;
  }

  getTags(): readonly PooledTag[] {
    return this.tags;
  }
}

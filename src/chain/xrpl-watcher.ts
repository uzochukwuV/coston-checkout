/**
 * Read-only XRPL client — Core Vault payment monitoring.
 *
 * Watches the FAssets Core Vault XRPL address for incoming Payment transactions,
 * extracts destination tag + memo + amount. Used by the checkout service to match
 * customer payments to open orders.
 *
 * Security: all extracted fields (memo, destinationTag, amount, source) are
 * UNTRUSTED. Match orders only after the FDC XRPPayment proof confirms these
 * on-chain. Never trust raw XRPL memo bytes for business logic.
 */
import { Client } from "xrpl";

export interface VaultPayment {
  txHash: string;
  sourceAddress: string;
  destinationTag?: number;
  amountDrops: string;
  memoData?: string; // hex, no 0x prefix
  ledgerIndex: number;
}

export class XrplWatcher {
  private client: Client;
  private connected = false;

  constructor(wsUrl: string) {
    this.client = new Client(wsUrl);
  }

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.disconnect();
      this.connected = false;
    }
  }

  /**
   * Fetch recent transactions sent to `vaultAddress` and extract payment fields.
   * Uses account_tx on the vault address, filtered to Payment type.
   */
  async getRecentVaultPayments(
    vaultAddress: string,
    limit = 50,
  ): Promise<VaultPayment[]> {
    await this.connect();
    const result = await this.client.request({
      command: "account_tx",
      account: vaultAddress,
      limit,
      forward: false,
    });
    const txs = (result.result as { transactions: any[] }).transactions ?? [];
    const payments: VaultPayment[] = [];
    for (const t of txs) {
      const tx = t.tx ?? t.tx_json;
      if (!tx || tx.TransactionType !== "Payment") continue;
      if (tx.Destination !== vaultAddress) continue;
      let memoData: string | undefined;
      if (Array.isArray(tx.Memos) && tx.Memos.length > 0) {
        const md = tx.Memos[0]?.Memo?.MemoData;
        if (typeof md === "string") memoData = md.toLowerCase();
      }
      // tx.Amount is often undefined in account_tx responses; the authoritative
      // delivered amount is meta.delivered_amount (a string for XRP, in drops).
      const delivered = t.meta?.delivered_amount ?? tx.Amount;
      let amountDrops: string;
      if (typeof delivered === "string") {
        amountDrops = delivered;
      } else if (delivered && typeof delivered === "object" && delivered.value) {
        // Issued-currency amount (shouldn't happen for XRP to the vault, but handle it)
        amountDrops = String(delivered.value);
      } else {
        amountDrops = String(delivered ?? "0");
      }
      payments.push({
        txHash: t.hash ?? tx.hash,
        sourceAddress: tx.Account,
        destinationTag: typeof tx.DestinationTag === "number" ? tx.DestinationTag : undefined,
        amountDrops,
        memoData,
        ledgerIndex: t.ledger_index ?? 0,
      });
    }
    return payments;
  }
}

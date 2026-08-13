/**
 * Build an XRPL Payment URI for deep-linking to wallets.
 * Format: https://xrpl.services/send/xrp?to=...&amount=...&dt=...&memo=...
 * Also returns the raw payment JSON for display.
 */

export interface XrplPaymentParams {
  destination: string;
  amountDrops: string;
  destinationTag?: number;
  memoHex?: string;
}

/** Coston2 / testnet Core Vault address — read from the order's tag/merchant data. */
export const TESTNET_CORE_VAULT = "rDhpmiPq4BVBDWMVdSrmkgt8thKyRzGV1p";

export function buildXrplPaymentUri(params: XrplPaymentParams): string {
  const search = new URLSearchParams();
  search.set("to", params.destination);
  search.set("amount", (Number(params.amountDrops) / 1_000_000).toString());
  if (params.destinationTag) search.set("dt", params.destinationTag.toString());
  if (params.memoHex) search.set("memo", params.memoHex);
  return `https://xrpl.services/send/xrp?${search.toString()}`;
}

export function buildXrplPaymentJson(params: XrplPaymentParams): object {
  const payment: Record<string, unknown> = {
    TransactionType: "Payment",
    Destination: params.destination,
    Amount: params.amountDrops,
  };
  if (params.destinationTag) payment.DestinationTag = params.destinationTag;
  if (params.memoHex) {
    payment.Memos = [
      {
        Memo: {
          MemoType: "text/plain",
          MemoData: params.memoHex,
          MemoFormat: "hex",
        },
      },
    ];
  }
  return payment;
}

/**
 * Signed merchant webhooks.
 *
 * Pure logic. HMAC-SHA256 over a canonical payload so the merchant can verify
 * settlement without trusting the checkout service. The merchant verifies the
 * signature over {orderId, flareTxHash, fdcAttestationId, fxrpSettled} using the
 * shared webhook secret.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookPayload {
  orderId: string;
  flareTxHash: string;
  fdcAttestationId: string;
  fxrpSettled: string; // FXRP minted (Flow A), as a decimal string
  status: string;
  // Flow B (settle-to-XRP) fields
  settlementMode?: string; // "FXRP" | "XRP"
  merchantXrpDrops?: string; // XRP paid to merchant (Flow B)
  redemptionRequestId?: string; // FAssets redemption request id
  redemptionPaymentTxHash?: string; // XRPL tx of the agent payout
  feeBreakdown?: {
    customerXrpDrops: string;
    mintFeeDrops: string;
    fxrpMintedDrops: string;
    redeemFeeDrops: string;
    operatorFeeDrops: string;
    merchantFxrpDrops: string;
    merchantXrpDrops: string;
  };
}

export interface SignedWebhook {
  payload: WebhookPayload;
  signature: string; // hex
  timestamp: number;
}

const SIG_HEADER = "X-Checkout-Signature";
const TS_HEADER = "X-Checkout-Timestamp";

/** Canonical message to sign: timestamp + "." + JSON.stringify(payload). */
function canonicalMessage(timestamp: number, payload: WebhookPayload): string {
  return `${timestamp}.${JSON.stringify(payload)}`;
}

export function signWebhook(
  payload: WebhookPayload,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): SignedWebhook {
  const msg = canonicalMessage(timestamp, payload);
  const sig = createHmac("sha256", secret).update(msg).digest("hex");
  return { payload, signature: sig, timestamp };
}

/** Verify a webhook signature (constant-time). Returns true if valid + not stale. */
export function verifyWebhook(
  wh: SignedWebhook,
  secret: string,
  maxAgeSeconds = 300,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (nowSec - wh.timestamp > maxAgeSeconds) return false;
  const msg = canonicalMessage(wh.timestamp, wh.payload);
  const expected = createHmac("sha256", secret).update(msg).digest("hex");
  const a = Buffer.from(wh.signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const WEBHOOK_HEADERS = { SIG_HEADER, TS_HEADER } as const;

/** Deliver a signed webhook via fetch (best-effort; returns the response). */
export async function deliverWebhook(
  url: string,
  wh: SignedWebhook,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [SIG_HEADER]: wh.signature,
      [TS_HEADER]: String(wh.timestamp),
    },
    body: JSON.stringify(wh.payload),
  });
}

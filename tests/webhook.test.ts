import { describe, it, expect } from "vitest";
import { signWebhook, verifyWebhook, type SignedWebhook, type WebhookPayload } from "../src/checkout/webhook.js";

const SECRET = "test-webhook-secret";

function mockPayload(overrides: Partial<WebhookPayload> = {}): WebhookPayload {
  return {
    orderId: "ord_1",
    flareTxHash: "0xflare123",
    fdcAttestationId: "0xxrpltx456",
    fxrpSettled: "10.5",
    status: "SETTLED",
    ...overrides,
  };
}

describe("webhook signing + verification", () => {
  it("round-trips sign → verify with the same secret", () => {
    const signed = signWebhook(mockPayload(), SECRET);
    expect(verifyWebhook(signed, SECRET)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const signed = signWebhook(mockPayload(), SECRET);
    const tampered: SignedWebhook = {
      ...signed,
      payload: { ...signed.payload, fxrpSettled: "9999" },
    };
    expect(verifyWebhook(tampered, SECRET)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const signed = signWebhook(mockPayload(), SECRET);
    const tampered: SignedWebhook = {
      ...signed,
      signature: "0".repeat(64),
    };
    expect(verifyWebhook(tampered, SECRET)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const signed = signWebhook(mockPayload(), SECRET);
    expect(verifyWebhook(signed, "wrong-secret")).toBe(false);
  });

  it("rejects a stale webhook (old timestamp)", () => {
    const oldTs = Math.floor(Date.now() / 1000) - 1000;
    const signed = signWebhook(mockPayload(), SECRET, oldTs);
    expect(verifyWebhook(signed, SECRET)).toBe(false);
  });

  it("accepts within the freshness window", () => {
    const ts = Math.floor(Date.now() / 1000) - 60;
    const signed = signWebhook(mockPayload(), SECRET, ts);
    expect(verifyWebhook(signed, SECRET)).toBe(true);
  });

  it("signature is deterministic for the same input", () => {
    const ts = 12345;
    const a = signWebhook(mockPayload(), SECRET, ts);
    const b = signWebhook(mockPayload(), SECRET, ts);
    expect(a.signature).toBe(b.signature);
  });
});

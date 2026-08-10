/**
 * FDC client tests — round discovery + proof endpoints against Coston2.
 *
 * These hit the live Coston2 DA Layer (https://ctn2-data-availability.flare.network/).
 * Skipped automatically when the network is unreachable so CI without network
 * access still passes. Run with `vitest run tests/fdc.test.ts` to exercise them.
 */
import { describe, it, expect } from "vitest";
import { FdcClient } from "../src/chain/fdc.js";

const COSTON2_DA = "https://ctn2-data-availability.flare.network/";

async function networkUp(url: string): Promise<boolean> {
  try {
    const r = await fetch(url + "api/health", { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

const online = await networkUp(COSTON2_DA);
const maybe = online ? describe : describe.skip;

maybe("FdcClient — live Coston2 round discovery", () => {
  it("getLatestFdcRound returns a positive, monotonically-stable round id", async () => {
    const fdc = new FdcClient({ verifierUrl: "", verifierApiKey: "", daLayerUrl: COSTON2_DA });
    const r1 = await fdc.getLatestFdcRound();
    expect(typeof r1).toBe("number");
    expect(r1).toBeGreaterThan(0);
    // round id should not decrease between two reads within the same test window
    const r2 = await fdc.getLatestFdcRound();
    expect(r2).toBeGreaterThanOrEqual(r1);
  });

  it("getLatestProof throws for a non-existent requestBytes (empty proof)", async () => {
    const fdc = new FdcClient({ verifierUrl: "", verifierApiKey: "", daLayerUrl: COSTON2_DA });
    // a deliberately bogus requestBytes — the DA layer returns 200 with an empty
    // proof; the client should surface this as "not yet finalized".
    await expect(
      fdc.getLatestProof("0x" + "00".repeat(150)),
    ).rejects.toThrow(/not yet finalized/);
  });

  it("prepareXrpPaymentProof rejects an invalid tx hash length", async () => {
    const fdc = new FdcClient({ verifierUrl: "", verifierApiKey: "", daLayerUrl: COSTON2_DA });
    await expect(
      fdc.prepareXrpPaymentProof("abc", "0x" + "11".repeat(20), true),
    ).rejects.toThrow(/64 hex chars/);
  });

  it("prepareXrpPaymentProof rejects an invalid proofOwner", async () => {
    const fdc = new FdcClient({ verifierUrl: "", verifierApiKey: "", daLayerUrl: COSTON2_DA });
    await expect(
      fdc.prepareXrpPaymentProof("0".repeat(64), "not-an-address", true),
    ).rejects.toThrow(/proofOwner must be a valid 0x address/);
  });
});

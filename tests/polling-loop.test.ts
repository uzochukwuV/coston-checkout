import { describe, it, expect, vi } from "vitest";
import { PollingLoop } from "../src/checkout/polling-loop.js";
import type { CheckoutService } from "../src/checkout/checkout-service.js";

/** Minimal mock — only the methods PollingLoop touches. */
function mockService(
  pollResult: () => Promise<unknown[]>,
  expireResult: () => unknown[],
): CheckoutService {
  return {
    pollAndMatch: vi.fn(pollResult),
    expireStale: vi.fn(expireResult),
  } as unknown as CheckoutService;
}

describe("PollingLoop", () => {
  it("runOnce calls pollAndMatch and expireStale and returns a summary", async () => {
    const settled = [{ id: "ord_1" }];
    const expired = [{ id: "ord_2" }];
    const svc = mockService(
      async () => settled,
      () => expired,
    );
    const loop = new PollingLoop(svc);

    const result = await loop.runOnce();

    expect(svc.pollAndMatch).toHaveBeenCalledTimes(1);
    expect(svc.expireStale).toHaveBeenCalledTimes(1);
    expect(result.settled).toBe(1);
    expect(result.expired).toBe(1);
    expect(result.cycle).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("isolates errors — pollAndMatch throwing does not stop expireStale", async () => {
    const expired = [{ id: "ord_2" }];
    const svc = mockService(
      async () => {
        throw new Error("XRPL connection failed");
      },
      () => expired,
    );
    const errors: string[] = [];
    const loop = new PollingLoop(svc, { onError: (e) => errors.push(e.message) });

    const result = await loop.runOnce();

    expect(svc.expireStale).toHaveBeenCalledTimes(1);
    expect(result.error).toBe("XRPL connection failed");
    expect(result.expired).toBe(1);
    expect(errors).toEqual(["XRPL connection failed"]);
  });

  it("start/stop controls the loop without hanging", async () => {
    const svc = mockService(async () => [], () => []);
    const loop = new PollingLoop(svc, { intervalMs: 50, initialDelayMs: 10 });

    expect(loop.isRunning).toBe(false);
    loop.start();
    expect(loop.isRunning).toBe(true);

    // let a couple of cycles run
    await new Promise((r) => setTimeout(r, 80));

    await loop.stop();
    expect(loop.isRunning).toBe(false);

    const callCountBefore = (svc.pollAndMatch as any).mock.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    // no new cycles after stop
    expect((svc.pollAndMatch as any).mock.calls.length).toBe(callCountBefore);
  });

  it("start returns false if already running", () => {
    const svc = mockService(async () => [], () => []);
    const loop = new PollingLoop(svc, { intervalMs: 1000, initialDelayMs: 1000 });
    expect(loop.start()).toBe(true);
    expect(loop.start()).toBe(false); // already running
    loop.stop();
  });

  it("onCycle callback fires with the result", async () => {
    const svc = mockService(async () => [{ id: "x" }], () => []);
    const cycles: number[] = [];
    const loop = new PollingLoop(svc, {
      onCycle: (r) => cycles.push(r.cycle),
    });
    await loop.runOnce();
    expect(cycles).toEqual([1]);
  });
});

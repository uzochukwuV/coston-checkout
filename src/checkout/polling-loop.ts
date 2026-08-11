/**
 * Background polling loop — drives the checkout lifecycle automatically.
 *
 * Runs on an interval: poll XRPL for Core Vault payments, match them to open
 * orders, settle (mint via FDC proof), and expire stale quotes. Replaces the
 * manual POST /admin/poll trigger so settlement happens without intervention.
 *
 * Designed to be embedded in the API server process:
 *   const loop = new PollingLoop(svc, { intervalMs: 5000 });
 *   loop.start();
 *   ...
 *   await loop.stop();
 *
 * Error isolation: a failed poll cycle never stops the loop — errors are
 * logged and the next tick runs on schedule. This is critical because the XRPL
 * watcher, FDC DA layer, and Flare RPC are all external and may transiently
 * fail.
 */

import type { CheckoutService } from "./checkout-service.js";

export interface PollingLoopOptions {
  /** Milliseconds between poll cycles. Default 5000 (5s). */
  intervalMs?: number;
  /** Milliseconds to wait before the first poll. Default = intervalMs. */
  initialDelayMs?: number;
  /** Called with cycle errors (default: console.error). */
  onError?: (e: Error, cycle: number) => void;
  /** Called after each cycle with a summary. Default: no-op. */
  onCycle?: (summary: PollCycleResult) => void;
}

export interface PollCycleResult {
  cycle: number;
  settled: number;
  expired: number;
  durationMs: number;
  error?: string;
}

export class PollingLoop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private cycle = 0;

  constructor(
    private svc: CheckoutService,
    private opts: PollingLoopOptions = {},
  ) {}

  /** Start the loop. Returns true if it was not already running. */
  start(): boolean {
    if (this.running) return false;
    this.running = true;
    const intervalMs = this.opts.intervalMs ?? 5000;
    const delay = this.opts.initialDelayMs ?? intervalMs;
    this.scheduleNext(delay);
    return true;
  }

  /** Stop the loop and wait for the in-flight cycle to finish. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Run one poll cycle immediately (bypassing the schedule). For tests. */
  async runOnce(): Promise<PollCycleResult> {
    return this.tick();
  }

  private scheduleNext(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.tick()
        .catch(() => {
          // tick already handles errors internally; this is a safety net
        })
        .finally(() => {
          // schedule the next cycle only if still running
          if (this.running) {
            this.scheduleNext(this.opts.intervalMs ?? 5000);
          }
        });
    }, delay);
  }

  private async tick(): Promise<PollCycleResult> {
    const start = Date.now();
    this.cycle++;
    const cycleNum = this.cycle;
    const result: PollCycleResult = {
      cycle: cycleNum,
      settled: 0,
      expired: 0,
      durationMs: 0,
    };

    try {
      const settled = await this.svc.pollAndMatch();
      result.settled = settled.length;
    } catch (e) {
      const err = e as Error;
      result.error = err.message;
      this.opts.onError?.(err, cycleNum);
    }

    try {
      const expired = this.svc.expireStale();
      result.expired = expired.length;
    } catch (e) {
      // expireStale is synchronous + pure; shouldn't throw, but be safe
      const err = e as Error;
      result.error = result.error ?? err.message;
      this.opts.onError?.(err, cycleNum);
    }

    result.durationMs = Date.now() - start;
    this.opts.onCycle?.(result);
    return result;
  }
}

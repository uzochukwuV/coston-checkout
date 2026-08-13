/**
 * XRPL payment sender — sends XRP Payments from the operator wallet.
 *
 * Used by CheckoutService for refunds: when a Flow B redemption fails after
 * max retries, the operator refunds the customer's XRP (minus the sunk mint fee).
 *
 * DRY_RUN by default; set dryRun=false + seed to actually broadcast.
 */

import { Client, Wallet as XrplWallet } from "xrpl";

export interface XrplSendResult {
  ok: boolean;
  txHash?: string;
  error?: string;
  dryRun: boolean;
}

export interface XrplPayerConfig {
  wsUrl: string;
  /** XRPL wallet seed for the operator/funder. Required to broadcast. */
  seed?: string;
  dryRun: boolean;
}

export class XrplPayer {
  private client: Client;
  private wallet: XrplWallet | undefined;
  private cfg: XrplPayerConfig;
  private connected = false;

  constructor(cfg: XrplPayerConfig) {
    this.cfg = cfg;
    this.client = new Client(cfg.wsUrl);
    if (cfg.seed) {
      this.wallet = XrplWallet.fromSeed(cfg.seed);
    }
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

  getFunderAddress(): string | undefined {
    return this.wallet?.address;
  }

  /**
   * Send an XRP Payment from the funder wallet to `destination`.
   * Returns the XRPL tx hash on success.
   */
  async sendPayment(
    destination: string,
    amountDrops: string,
    destinationTag?: number,
  ): Promise<XrplSendResult> {
    if (this.cfg.dryRun || !this.wallet) {
      return {
        ok: false,
        dryRun: true,
        error: this.cfg.dryRun
          ? "DRY_RUN — would send XRPL Payment"
          : "no seed configured — cannot broadcast",
      };
    }
    try {
      await this.connect();
      const prepared = await this.client.autofill({
        TransactionType: "Payment",
        Account: this.wallet.address,
        Destination: destination,
        Amount: amountDrops,
        ...(destinationTag ? { DestinationTag: destinationTag } : {}),
      });
      const signed = this.wallet.sign(prepared);
      const response = await this.client.submit(signed.tx_blob);
      if (response.result.engine_result !== "tesSUCCESS") {
        return {
          ok: false,
          dryRun: false,
          txHash: signed.hash,
          error: `${response.result.engine_result}: ${response.result.engine_result_message}`,
        };
      }
      return { ok: true, dryRun: false, txHash: signed.hash };
    } catch (e) {
      return { ok: false, dryRun: false, error: (e as Error).message };
    }
  }
}

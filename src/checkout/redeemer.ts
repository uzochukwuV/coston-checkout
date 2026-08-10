/**
 * Redeemer — settles Flow B by redeeming minted FXRP for XRP via
 * AssetManager.redeemWithTag, paying out to the merchant's XRPL address
 * (with a destination tag for exchanges).
 *
 * Flow: approve FXRP → redeemWithTag(amountUBA, xrplAddress, executor, tag)
 *       → parse RedemptionWithTagRequested event for requestId → (wait for
 *       agent payout on XRPL) → confirmXRPRedemptionPayment OR
 *       redemptionPaymentDefault(proof, requestId) if the agent defaults.
 *
 * The operator wallet holds the FXRP and pays the FLR gas. This is gasless for
 * the merchant, who only receives XRP on XRPL.
 *
 * Idempotency: keyed on the order id (one redemption per order); the requestId
 * from the event is stored on the order to track the agent payout.
 *
 * Security: FDC proofs for confirm/default are UNTRUSTED; the on-chain contract
 * re-verifies. We only act after proof finalization.
 *
 * DRY_RUN by default; set DRY_RUN=false + PRIVATE_KEY to broadcast.
 */

import { Contract, JsonRpcProvider, Wallet, id, keccak256 } from "ethers";
import type { FeeParams } from "../chain/asset-manager.js";
import { isRedeemable } from "./pricing.js";

const ASSET_MANAGER_ABI = [
  "function fAsset() view returns (address)",
  "function minimumRedeemAmountUBA() view returns (uint256)",
  "function redeemWithTag(uint256 _amountUBA, string _redeemerUnderlyingAddressString, address payable _executor, uint256 _destinationTag) returns (uint256)",
  "function redeemWithTagSupported() view returns (bool)",
  "event RedemptionWithTagRequested(uint256 indexed redemptionRequestId, uint256 amountUBA, string redeemerUnderlyingAddressString, uint256 destinationTag)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface RedeemResult {
  ok: boolean;
  flareTxHash?: string;
  requestId?: bigint;
  amountUBA?: bigint;
  error?: string;
  dryRun: boolean;
}

export interface RedeemerConfig {
  rpcUrl: string;
  assetManagerAddress: string;
  privateKey?: string;
  dryRun: boolean;
}

export class Redeemer {
  private provider: JsonRpcProvider;
  private wallet: Wallet | undefined;
  private am: Contract;
  private cfg: RedeemerConfig;

  constructor(cfg: RedeemerConfig) {
    this.cfg = cfg;
    this.provider = new JsonRpcProvider(cfg.rpcUrl);
    if (cfg.privateKey) {
      this.wallet = new Wallet(cfg.privateKey, this.provider);
    }
    this.am = new Contract(
      cfg.assetManagerAddress,
      ASSET_MANAGER_ABI,
      this.wallet ?? this.provider,
    );
  }

  /** Redeem `amountUBA` of FXRP to an XRPL address with a destination tag. */
  async redeemWithTag(
    amountUBA: bigint,
    xrplAddress: string,
    destinationTag: number,
    fees: FeeParams,
  ): Promise<RedeemResult> {
    // validate redeemWithTag is supported
    const supported: boolean = await this.am.redeemWithTagSupported();
    if (!supported) {
      return { ok: false, dryRun: this.cfg.dryRun, error: "redeemWithTag not supported" };
    }
    if (!isRedeemable(amountUBA, fees.minimumRedeemAmountUBA)) {
      return {
        ok: false,
        dryRun: this.cfg.dryRun,
        error: `amount ${amountUBA} below minimumRedeemAmountUBA ${fees.minimumRedeemAmountUBA}`,
      };
    }
    if (destinationTag < 0 || destinationTag > 0xffffffff) {
      return { ok: false, dryRun: this.cfg.dryRun, error: "destinationTag out of uint32 range" };
    }

    if (this.cfg.dryRun || !this.wallet) {
      return {
        ok: false,
        dryRun: true,
        amountUBA,
        error: "DRY_RUN — would approve + redeemWithTag",
      };
    }

    try {
      // check FXRP balance
      const fxrpAddress: string = await this.am.fAsset();
      const fxrp = new Contract(fxrpAddress, ERC20_ABI, this.wallet);
      const balance: bigint = await fxrp.balanceOf(this.wallet.address);
      if (balance < amountUBA) {
        return {
          ok: false,
          dryRun: false,
          error: `insufficient FXRP: have ${balance}, need ${amountUBA}`,
        };
      }
      // approve
      const approveTx = await fxrp.approve(this.cfg.assetManagerAddress, amountUBA);
      await approveTx.wait();
      // redeem
      const tx = await this.am.redeemWithTag(
        amountUBA,
        xrplAddress,
        ZERO_ADDRESS,
        destinationTag,
      );
      const receipt = await tx.wait();
      // parse requestId from RedemptionWithTagRequested event
      const eventSig = id("RedemptionWithTagRequested(uint256,uint256,string,uint256)");
      const log = receipt.logs.find((l: { topics: string[] }) => l.topics[0] === eventSig);
      let requestId: bigint | undefined;
      if (log && log.topics[1]) {
        requestId = BigInt(log.topics[1]);
      }
      return {
        ok: true,
        dryRun: false,
        flareTxHash: receipt.hash,
        requestId,
        amountUBA,
      };
    } catch (e) {
      return { ok: false, dryRun: false, error: (e as Error).message };
    }
  }
}

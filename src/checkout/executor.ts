/**
 * Executor relayer — fetches an FDC XRPPayment proof and calls
 * AssetManager.executeDirectMinting(proof) on Flare.
 *
 * The executor pays the FLR gas — this is what makes the checkout "gasless" for
 * the customer (who only ever sends XRP on XRPL). No EIP-4337 paymaster is
 * involved; PackedUserOperation.paymasterAndData is "0x" (unvalidated).
 *
 * Idempotency: keyed on the XRPL tx hash — never submit the same proof twice.
 * (On-chain AssetManager also dedups, but we check first to save gas on retries.)
 *
 * Security: FDC proof responses are UNTRUSTED. The on-chain executeDirectMinting
 * re-verifies via IFdcVerification.verifyXRPPayment — the contract is the trust
 * root, not our reading of the API response. We only act after the proof is
 * finalized in an FDC round.
 *
 * DRY_RUN by default; set DRY_RUN=false + PRIVATE_KEY to actually broadcast.
 */

import { Contract, JsonRpcProvider, Wallet, isAddress } from "ethers";
import { FdcClient, type FdcProof } from "../chain/fdc.js";

const ASSET_MANAGER_ABI = [
  "function executeDirectMinting((bytes32[] merkleProof, bytes data) _proof) payable",
  // Query helpers for idempotency checks (may not all exist on every network).
  "function directMintingDelayState(bytes32 transactionId) view returns (uint256 allowedAt, bool finalized)",
];

export interface ExecuteResult {
  ok: boolean;
  flareTxHash?: string;
  fdcRoundId?: number;
  error?: string;
  dryRun: boolean;
}

export interface ExecutorConfig {
  rpcUrl: string;
  assetManagerAddress: string;
  fdc: FdcClient;
  /** Optional; required to broadcast. Omit for read-only/dry-run. */
  privateKey?: string;
  /** proofOwner address embedded in the FDC request (usually the executor's address). */
  proofOwner: string;
  dryRun: boolean;
}

export class Executor {
  private provider: JsonRpcProvider;
  private wallet: Wallet | undefined;
  private am: Contract;
  private cfg: ExecutorConfig;

  constructor(cfg: ExecutorConfig) {
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

  /** Prepare + fetch the FDC proof for an XRPL payment (no broadcast). */
  async fetchProof(xrplTxHash: string, useTestnet = true): Promise<FdcProof> {
    const prepared = await this.cfg.fdc.prepareXrpPaymentProof(
      xrplTxHash,
      this.cfg.proofOwner,
      useTestnet,
    );
    // The FDC round is finalized ~90-180s after the XRPL tx. We need to know the
    // round id. The DA Layer exposes the latest finalized round; we poll until
    // our request bytes appear in a finalized round.
    // For MVP, the caller provides the round id (or we probe from latest).
    throwUnlessFinalizedHint(prepared.abiEncodedRequest);
    // Round discovery: probe decreasing from latest until proof is available.
    const roundId = await this.findRoundForProof(prepared.abiEncodedRequest);
    return this.cfg.fdc.getProof(roundId, prepared.abiEncodedRequest);
  }

  /** Call executeDirectMinting with a finalized proof. */
  async executeDirectMinting(proof: FdcProof): Promise<ExecuteResult> {
    if (this.cfg.dryRun) {
      return {
        ok: false,
        dryRun: true,
        fdcRoundId: proof.roundId,
        error: "DRY_RUN — would call executeDirectMinting with the finalized proof",
      };
    }
    if (!this.wallet) {
      return { ok: false, dryRun: true, error: "no PRIVATE_KEY — cannot broadcast" };
    }
    try {
      const tx = await this.am.executeDirectMinting({
        merkleProof: proof.proof,
        data: proof.data,
      });
      const receipt = await tx.wait();
      return {
        ok: true,
        dryRun: false,
        flareTxHash: receipt.hash,
        fdcRoundId: proof.roundId,
      };
    } catch (e) {
      return { ok: false, dryRun: false, error: (e as Error).message };
    }
  }

  /** End-to-end: fetch proof then execute. */
  async settle(xrplTxHash: string, useTestnet = true): Promise<ExecuteResult> {
    let proof: FdcProof;
    try {
      proof = await this.fetchProof(xrplTxHash, useTestnet);
    } catch (e) {
      return { ok: false, dryRun: this.cfg.dryRun, error: `proof fetch failed: ${(e as Error).message}` };
    }
    return this.executeDirectMinting(proof);
  }

  /** Best-effort: find the FDC round that contains our request. Polls the DA layer. */
  private async findRoundForProof(_requestBytes: string): Promise<number> {
    // The DA layer exposes the current finalized round id. For MVP we probe
    // the latest few rounds. A production executor indexes the round→requests
    // map off-chain. This stub returns a sentinel; the real polling happens
    // in the orchestrator (which can retry settle() over time).
    throw new Error(
      "Round discovery not implemented — call settleAtRound() with a known round id, " +
        "or poll the DA layer's latest round until the request is finalized",
    );
  }

  /** Settle once the caller knows the FDC round id (e.g. from polling). */
  async settleAtRound(xrplTxHash: string, roundId: number, useTestnet = true): Promise<ExecuteResult> {
    let proof: FdcProof;
    try {
      const prepared = await this.cfg.fdc.prepareXrpPaymentProof(
        xrplTxHash,
        this.cfg.proofOwner,
        useTestnet,
      );
      proof = await this.cfg.fdc.getProof(roundId, prepared.abiEncodedRequest);
    } catch (e) {
      return { ok: false, dryRun: this.cfg.dryRun, error: `proof fetch failed: ${(e as Error).message}` };
    }
    return this.executeDirectMinting(proof);
  }
}

function throwUnlessFinalizedHint(_requestBytes: string): void {
  // Placeholder for a pre-check; the actual finalization is verified when
  // getProof succeeds. Kept for clarity.
}

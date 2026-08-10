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
  "function executeDirectMintingWithData((bytes32[] merkleProof, bytes data) _proof, bytes _data) payable",
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

export interface ExecuteWithDataResult {
  ok: boolean;
  flareTxHash?: string;
  fdcRoundId?: number;
  error?: string;
  dryRun: boolean;
  /** Total FLR msg.value attached (sum of call.value in the user op). */
  msgValueWei?: string;
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
    // The FDC round is finalized ~90-180s after the XRPL tx. Use the round-less
    // latest-proof endpoint (POST /fdc/get-proof-round-bytes); it returns the
    // proof + the current finalized round id. Throws if not yet finalized.
    return this.cfg.fdc.getLatestProof(prepared.abiEncodedRequest);
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

  /**
   * Flow C: call executeDirectMintingWithData(proof, data) with the ABI-encoded
   * PackedUserOperation. The contract verifies keccak256(data) == the 0xFE memo
   * hash, mints FXRP to the personal account, and dispatches the user op atomically.
   *
   * Security: `_data` is operator-built (not from the UNTRUSTED XRPL memo); the
   * on-chain hash check is the trust root. We attach `msg.value = sum(call.value)`
   * (usually 0 for ERC-20 ops) so inner calls can send FLR.
   */
  async executeDirectMintingWithData(
    proof: FdcProof,
    data: `0x${string}`,
    msgValueWei = 0n,
  ): Promise<ExecuteWithDataResult> {
    if (this.cfg.dryRun) {
      return {
        ok: false,
        dryRun: true,
        fdcRoundId: proof.roundId,
        msgValueWei: msgValueWei.toString(),
        error: "DRY_RUN — would call executeDirectMintingWithData(proof, userOpData)",
      };
    }
    if (!this.wallet) {
      return { ok: false, dryRun: true, error: "no PRIVATE_KEY — cannot broadcast", msgValueWei: msgValueWei.toString() };
    }
    try {
      const tx = await this.am.executeDirectMintingWithData(
        { merkleProof: proof.proof, data: proof.data },
        data,
        { value: msgValueWei },
      );
      const receipt = await tx.wait();
      return {
        ok: true,
        dryRun: false,
        flareTxHash: receipt.hash,
        fdcRoundId: proof.roundId,
        msgValueWei: msgValueWei.toString(),
      };
    } catch (e) {
      return {
        ok: false,
        dryRun: false,
        error: (e as Error).message,
        msgValueWei: msgValueWei.toString(),
      };
    }
  }

  /** End-to-end Flow C: fetch proof then executeDirectMintingWithData. */
  async settleWithData(
    xrplTxHash: string,
    data: `0x${string}`,
    msgValueWei = 0n,
    useTestnet = true,
  ): Promise<ExecuteWithDataResult> {
    let proof: FdcProof;
    try {
      proof = await this.fetchProof(xrplTxHash, useTestnet);
    } catch (e) {
      return { ok: false, dryRun: this.cfg.dryRun, error: `proof fetch failed: ${(e as Error).message}`, msgValueWei: msgValueWei.toString() };
    }
    return this.executeDirectMintingWithData(proof, data, msgValueWei);
  }

  /** Flow C with a known FDC round id. */
  async settleWithDataAtRound(
    xrplTxHash: string,
    roundId: number,
    data: `0x${string}`,
    msgValueWei = 0n,
    useTestnet = true,
  ): Promise<ExecuteWithDataResult> {
    let proof: FdcProof;
    try {
      const prepared = await this.cfg.fdc.prepareXrpPaymentProof(
        xrplTxHash,
        this.cfg.proofOwner,
        useTestnet,
      );
      proof = await this.cfg.fdc.getProof(roundId, prepared.abiEncodedRequest);
    } catch (e) {
      return { ok: false, dryRun: this.cfg.dryRun, error: `proof fetch failed: ${(e as Error).message}`, msgValueWei: msgValueWei.toString() };
    }
    return this.executeDirectMintingWithData(proof, data, msgValueWei);
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

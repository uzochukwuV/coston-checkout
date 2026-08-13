/**
 * On-chain FDC attestation submission + finalization polling.
 *
 * The FDC flow (per skill reference):
 *   1. Prepare: POST to verifier → abiEncodedRequest
 *   2. Submit:  FdcHub.requestAttestation(abiEncodedRequest) with value = fee
 *   3. Round ID: from receipt block timestamp via FlareSystemsManager
 *   4. Wait:    Relay.isFinalized(PROTOCOL_ID_FDC=200, roundId)
 *   5. Fetch:   DA layer get-proof-round-id-bytes(roundId, requestBytes)
 *
 * Without step 2, no attestation provider processes the request and the DA
 * layer never has a proof. This module handles steps 2–4.
 *
 * Security: the abiEncodedRequest comes from the verifier (which embeds a
 * message integrity code). We submit it verbatim — the on-chain FDC is the
 * trust root for attestation consensus, and the DA-layer proof is verified
 * on-chain by the consumer contract (e.g. AssetManager.executeDirectMinting).
 */

import { Contract, JsonRpcProvider, Wallet, formatEther } from "ethers";

/** FDC protocol ID used by Relay.isFinalized. */
export const PROTOCOL_ID_FDC = 200;

const FDC_HUB_ABI = [
  "function requestAttestation(bytes _data) payable",
];

const FEE_CONFIG_ABI = [
  "function getRequestFee(bytes _data) view returns (uint256)",
];

const RELAY_ABI = [
  "function isFinalized(uint256 _protocolId, uint256 _votingRoundId) view returns (bool)",
];

const SYSTEMS_MANAGER_ABI = [
  "function firstVotingRoundStartTs() view returns (uint256)",
  "function votingEpochDurationSeconds() view returns (uint256)",
];

export interface FdcHubConfig {
  rpcUrl: string;
  fdcHubAddress: string;
  feeConfigAddress: string;
  relayAddress: string;
  flareSystemsManagerAddress: string;
  /** Optional; required to broadcast requestAttestation. */
  privateKey?: string;
}

export interface AttestationSubmission {
  flareTxHash: string;
  blockNumber: number;
  blockTimestamp: number;
  /** Computed FDC voting round id for this attestation. */
  roundId: number;
  /** Fee paid (wei). */
  fee: bigint;
}

export class FdcHubClient {
  private provider: JsonRpcProvider;
  private wallet: Wallet | undefined;
  private hub: Contract;
  private feeConfig: Contract;
  private relay: Contract;
  private systemsManager: Contract;

  constructor(private cfg: FdcHubConfig) {
    this.provider = new JsonRpcProvider(cfg.rpcUrl);
    if (cfg.privateKey) {
      this.wallet = new Wallet(cfg.privateKey, this.provider);
    }
    const signer = this.wallet ?? this.provider;
    this.hub = new Contract(cfg.fdcHubAddress, FDC_HUB_ABI, this.wallet ?? this.provider);
    this.feeConfig = new Contract(cfg.feeConfigAddress, FEE_CONFIG_ABI, this.provider);
    this.relay = new Contract(cfg.relayAddress, RELAY_ABI, this.provider);
    this.systemsManager = new Contract(cfg.flareSystemsManagerAddress, SYSTEMS_MANAGER_ABI, this.provider);
    // Use signer for hub (broadcast), provider for reads
    void signer;
  }

  /** Get the minimum required fee (wei) for an attestation request. */
  async getRequestFee(abiEncodedRequest: string): Promise<bigint> {
    return this.feeConfig.getRequestFee(abiEncodedRequest);
  }

  /**
   * Submit an attestation request on-chain via FdcHub.requestAttestation().
   * Requires a funded wallet (privateKey). Returns the Flare tx hash and the
   * computed FDC voting round id.
   */
  async submitAttestation(abiEncodedRequest: string): Promise<AttestationSubmission> {
    if (!this.wallet) {
      throw new Error("FdcHubClient: privateKey required to submit attestations");
    }
    const fee = await this.getRequestFee(abiEncodedRequest);
    if (fee === 0n) {
      throw new Error("FdcHubClient: getRequestFee returned 0 — check FdcRequestFeeConfigurations");
    }

    const tx = await this.hub.requestAttestation(abiEncodedRequest, { value: fee });
    const receipt = await tx.wait();

    if (!receipt.blockNumber || receipt.blockNumber === 0) {
      throw new Error("FdcHubClient: tx not mined");
    }

    const block = await this.provider.getBlock(receipt.blockNumber);
    if (!block || block.timestamp === null) {
      throw new Error("FdcHubClient: cannot read block timestamp");
    }

    const roundId = await this.computeRoundId(block.timestamp);
    return {
      flareTxHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      blockTimestamp: block.timestamp,
      roundId,
      fee,
    };
  }

  /** Compute the FDC voting round id from a block timestamp. */
  async computeRoundId(blockTimestamp: number): Promise<number> {
    const [startTs, epochDuration] = await Promise.all([
      this.systemsManager.firstVotingRoundStartTs(),
      this.systemsManager.votingEpochDurationSeconds(),
    ]);
    if (epochDuration === 0n) {
      throw new Error("votingEpochDurationSeconds is 0 — cannot compute round id");
    }
    return Number((BigInt(blockTimestamp) - startTs) / epochDuration);
  }

  /** Check whether an FDC round has been finalized on-chain via Relay. */
  async isFinalized(roundId: number): Promise<boolean> {
    return this.relay.isFinalized(PROTOCOL_ID_FDC, roundId);
  }

  /**
   * Submit the attestation then poll Relay.isFinalized until the submission
   * round finalizes. Resolves with the finalized round id.
   * The attestation proof lives in the submission round's Merkle tree — we
   * poll THAT specific round, not later ones.
   */
  async submitAndWait(
    abiEncodedRequest: string,
    pollMs = 15000,
    timeoutMs = 600_000,
  ): Promise<AttestationSubmission> {
    const submission = await this.submitAttestation(abiEncodedRequest);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isFinalized(submission.roundId)) {
        return submission;
      }
      await sleep(pollMs);
    }
    throw new Error(`FDC round ${submission.roundId} did not finalize within ${timeoutMs / 1000}s`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

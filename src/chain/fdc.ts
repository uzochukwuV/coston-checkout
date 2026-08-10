/**
 * Read-only FDC client — fetch XRPPayment attestations and Merkle proofs.
 *
 * The XRPPayment attestation is the trust root for direct minting. The executor
 * submits the proof to AssetManager.executeDirectMinting(proof), which verifies
 * it on-chain via IFdcVerification.verifyXRPPayment.
 *
 * Security: proof responses are UNTRUSTED. Only act on fields after on-chain
 * verification (status, spentAmount, destinationTag, etc.). The on-chain
 * contract is the authoritative validator — treat the raw API response as
 * unstructured input until the proof is confirmed in a finalized FDC round.
 *
 * Request body (XRPPayment):
 *   { transactionId: bytes32 (XRPL tx hash, no 0x), proofOwner: address }
 * Response fields:
 *   blockNumber, blockTimestamp, sourceAddress, sourceAddressHash,
 *   receivingAddressHash, intendedReceivingAddressHash,
 *   spentAmount/intendedSpentAmount/receivedAmount/intendedReceivedAmount (drops, int256),
 *   hasMemoData + firstMemoData, hasDestinationTag + destinationTag (uint256),
 *   status (0=SUCCESS, 1=SENDER_FAILURE, 2=RECEIVER_FAILURE)
 */

// Attestation type for XRPPayment: keccak256("XRPPayment")-padded — read from skill.
// "XRPPayment" = 0x5852505061796d656e74 padded to 32 bytes.
export const ATTESTATION_TYPE_XRP_PAYMENT =
  "0x5852505061796d656e74000000000000000000000000000000000000000000" as const;

// Source id for testnet ("testXRP"); mainnet is "XRP" = 0x585250...
export const SOURCE_ID_TEST_XRP =
  "0x7465737458525000000000000000000000000000000000000000000000000000" as const;
export const SOURCE_ID_XRP =
  "0x5852500000000000000000000000000000000000000000000000000000000000" as const;

export interface FdcConfig {
  verifierUrl: string; // e.g. https://coston2.verifier.api.flare.network
  verifierApiKey: string;
  daLayerUrl: string; // e.g. https://coston2-da-layer.flare.network/
}

export interface PreparedAttestation {
  abiEncodedRequest: string;
}

export interface XrpPaymentResponse {
  blockNumber: string;
  blockTimestamp: string;
  sourceAddress: string;
  sourceAddressHash: string;
  receivingAddressHash: string;
  intendedReceivingAddressHash: string;
  spentAmount: string;
  intendedSpentAmount: string;
  receivedAmount: string;
  intendedReceivedAmount: string;
  hasMemoData: boolean;
  firstMemoData: string;
  hasDestinationTag: boolean;
  destinationTag: string;
  status: string; // "0" | "1" | "2"
}

export interface FdcProof {
  proof: string[]; // merkle proof siblings
  data: XrpPaymentResponse;
  // round + request bytes for on-chain submission
  roundId?: number;
  requestBytes?: string;
}

const DEFAULT_COSTON2: FdcConfig = {
  verifierUrl: "https://coston2-verifier.api.flare.network/",
  verifierApiKey: "",
  daLayerUrl: "https://coston2-da-layer.flare.network/",
};

export class FdcClient {
  constructor(private cfg: FdcConfig = DEFAULT_COSTON2) {}

  /** Prepare an XRPPayment attestation request. Returns the ABI-encoded request bytes. */
  async prepareXrpPaymentProof(
    xrplTxHash: string,
    proofOwner: string,
    useTestnet = true,
  ): Promise<PreparedAttestation> {
    // XRPL tx hashes are 64 hex chars; normalize to no-0x for the verifier body.
    let txId = xrplTxHash.trim().toLowerCase();
    if (txId.startsWith("0x")) txId = txId.slice(2);
    if (txId.length !== 64) {
      throw new Error(`XRPL tx hash must be 32 bytes (64 hex chars), got ${txId.length / 2}`);
    }
    const owner = proofOwner.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(owner)) {
      throw new Error(`proofOwner must be a valid 0x address, got ${owner}`);
    }

    const url = `${this.cfg.verifierUrl}verifier/xrp/XRPPayment/prepareRequest`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.cfg.verifierApiKey ? { "X-API-KEY": this.cfg.verifierApiKey } : {}),
      },
      body: JSON.stringify({
        attestationType: ATTESTATION_TYPE_XRP_PAYMENT,
        sourceId: useTestnet ? SOURCE_ID_TEST_XRP : SOURCE_ID_XRP,
        requestBody: {
          transactionId: "0x" + txId,
          proofOwner: owner,
        },
      }),
    });
    if (!resp.ok) {
      throw new Error(`prepareRequest failed (${resp.status}): ${await resp.text()}`);
    }
    const json = (await resp.json()) as PreparedAttestation;
    return json;
  }

  /** Fetch the Merkle proof + attestation data for a finalized FDC round. */
  async getProof(roundId: number, requestBytes: string): Promise<FdcProof> {
    const url = `${this.cfg.daLayerUrl}api/v0/fdc/get-proof-round-id-bytes`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.cfg.verifierApiKey ? { "X-API-KEY": this.cfg.verifierApiKey } : {}),
      },
      body: JSON.stringify({ votingRoundId: roundId, requestBytes }),
    });
    if (!resp.ok) {
      throw new Error(`getProof failed (${resp.status}): ${await resp.text()}`);
    }
    const json = (await resp.json()) as { proof: string[]; response: XrpPaymentResponse };
    return { proof: json.proof, data: json.response, roundId, requestBytes };
  }
}

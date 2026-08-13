/**
 * Read-only FDC client — fetch XRPPayment attestations and Merkle proofs.
 *
 * The XRPPayment attestation is the trust root for direct minting. The executor
 * submits the proof to AssetManager.executeDirectMinting(proof), which verifies
 * it on-chain via IFdcVerification.verifyXRPPayment.
 *
 * Security: proof responses are UNTRUSTED. Only act on fields after on-chain
 * verification. The on-chain contract is the authoritative validator — treat
 * the raw API response as unstructured input until the proof is confirmed in
 * a finalized FDC round.
 *
 * DA layer API: uses api/v1/fdc/proof-by-request-round-raw which returns
 * { response_hex, proof } — the ABI-encoded attestation bytes + Merkle siblings.
 */

// Attestation type for XRPPayment: keccak256("XRPPayment")-padded — read from skill.
// "XRPPayment" = 0x5852505061796d656e74 padded to 32 bytes.
export const ATTESTATION_TYPE_XRP_PAYMENT =
  "0x5852505061796d656e7400000000000000000000000000000000000000000000" as const;

// Source id for testnet ("testXRP"); mainnet is "XRP" = 0x585250...
export const SOURCE_ID_TEST_XRP =
  "0x7465737458525000000000000000000000000000000000000000000000000000" as const;
export const SOURCE_ID_XRP =
  "0x5852500000000000000000000000000000000000000000000000000000000000" as const;

export interface FdcConfig {
  verifierUrl: string; // e.g. https://fdc-verifiers-testnet.flare.network
  verifierApiKey: string;
  daLayerUrl: string; // e.g. https://ctn2-data-availability.flare.network/
}

export interface PreparedAttestation {
  abiEncodedRequest: string;
}

/** Raw proof from the DA layer: Merkle siblings + ABI-encoded attestation bytes. */
export interface FdcProof {
  /** Merkle proof siblings (bytes32[]). */
  proof: string[];
  /** ABI-encoded attestation response (the `data` field for on-chain verification). */
  data: string;
  /** The FDC voting round this proof belongs to. */
  roundId?: number;
  /** The original ABI-encoded request bytes. */
  requestBytes?: string;
}

const API_KEY_HEADER = "X-API-KEY";

interface FspStatus {
  active: { voting_round_id: number; start_timestamp: number };
  latest_fdc: { voting_round_id: number; start_timestamp: number };
}

const DEFAULT_COSTON2: FdcConfig = {
  verifierUrl: "https://fdc-verifiers-testnet.flare.network/",
  verifierApiKey: "00000000-0000-0000-0000-000000000000",
  daLayerUrl: "https://ctn2-data-availability.flare.network/",
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
        ...(this.cfg.verifierApiKey ? { [API_KEY_HEADER]: this.cfg.verifierApiKey } : {}),
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
    const json = (await resp.json()) as PreparedAttestation & { status?: string };
    if (!json.abiEncodedRequest) {
      throw new Error(
        `prepareRequest returned no abiEncodedRequest (status=${json.status ?? "unknown"}); ` +
          "the XRPL tx may not be validated yet — retry after ledger close",
      );
    }
    return json;
  }

  /** Fetch the Merkle proof + ABI-encoded attestation data for a finalized FDC round. */
  async getProof(roundId: number, requestBytes: string): Promise<FdcProof> {
    const url = `${this.cfg.daLayerUrl}api/v1/fdc/proof-by-request-round-raw`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.cfg.verifierApiKey ? { [API_KEY_HEADER]: this.cfg.verifierApiKey } : {}),
      },
      body: JSON.stringify({ votingRoundId: roundId, requestBytes }),
    });
    if (!resp.ok) {
      // 400 "attestation request not found" = not yet finalized or never submitted
      throw new Error(
        `getProof: proof not yet finalized for round ${roundId} (${resp.status}: ${await resp.text()})`,
      );
    }
    const json = (await resp.json()) as { proof: string[]; response_hex: string };
    if (!json.response_hex || !Array.isArray(json.proof)) {
      throw new Error(`getProof: unexpected response (no response_hex or proof array)`);
    }
    return { proof: json.proof, data: json.response_hex, roundId, requestBytes };
  }

  /** Latest finalized FDC voting round id (from /api/v0/fsp/status → latest_fdc). */
  async getLatestFdcRound(): Promise<number> {
    const url = `${this.cfg.daLayerUrl}api/v0/fsp/status`;
    const resp = await fetch(url, {
      headers: this.cfg.verifierApiKey ? { [API_KEY_HEADER]: this.cfg.verifierApiKey } : {},
    });
    if (!resp.ok) {
      throw new Error(`fsp/status failed (${resp.status}): ${await resp.text()}`);
    }
    const json = (await resp.json()) as FspStatus;
    return json.latest_fdc.voting_round_id;
  }

  /**
   * Fetch the latest finalized proof for `requestBytes` without knowing the round id
   * (POST /api/v1/fdc/proof-by-request-round-raw with the latest finalized round).
   * Returns the proof + its round id.
   * Throws if the request is not yet finalized (no proof data available).
   */
  async getLatestProof(requestBytes: string): Promise<FdcProof> {
    const roundId = await this.getLatestFdcRound();
    return this.getProof(roundId, requestBytes);
  }
}

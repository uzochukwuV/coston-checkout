/**
 * End-to-end live settlement test — Flow A (mint-to-merchant FXRP).
 *
 * Sends a REAL XRPL Payment to the FAssets Core Vault with a direct-minting
 * memo, waits for the FDC attestation to finalize, fetches the Merkle proof,
 * calls executeDirectMinting on Flare, and verifies the FXRP balance of the
 * merchant address increased.
 *
 * Prerequisites (the user funds these):
 *   1. FLARE operator wallet  — funded with C2FLR from https://faucet.flare.network/coston2
 *   2. XRPL customer wallet   — funded with test XRP from https://xrpl.org/resources/dev-tools/xrp-faucets
 *
 * Env (both required):
 *   OPERATOR_PRIVATE_KEY  Flare operator wallet private key (pays gas)
 *   XRPL_CUSTOMER_SEED     XRPL customer wallet seed (sends the Payment)
 *
 * Optional:
 *   FLARE_RPC_URL       default: Coston2
 *   XRPL_WS_URL         default: XRPL testnet
 *   MERCHANT_FLARE     default: a fresh random address (FXRP recipient)
 *   XRP_AMOUNT_DROPS   default: 1000000 (1 XRP) — must be > minimum fee
 *   FDC_POLL_MS        default: 15000 — how often to retry proof fetch
 *   FDC_TIMEOUT_MS     default: 600000 (10 min) — give up after this
 *
 * Usage: npx tsx src/scripts/e2e-mint.ts
 *
 * What this script does, step by step:
 *   1. Resolve live contract addresses (AssetManager, FXRP token, Core Vault, FdcHub, Relay)
 *   2. Read live fee params (minimum fee, fee BIPS, executor fee)
 *   3. Generate (or use env) merchant Flare address — the FXRP recipient
 *   4. Build the direct-minting memo: 0x4642505266410018 + zeros + merchant
 *   5. Submit an XRPL Payment from the customer wallet to the Core Vault
 *   6. Print the XRPL tx hash and wait for ledger close
 *   7. Prepare FDC attestation request, submit via FdcHub.requestAttestation()
 *   8. Poll Relay.isFinalized(200, roundId) until the FDC round finalizes
 *   9. Fetch the Merkle proof from the DA layer (get-proof-round-id-bytes)
 *  10. Call executeDirectMinting(proof) via the operator wallet (real gas)
 *  11. Verify: FXRP.balanceOf(merchant) > 0
 */

import { JsonRpcProvider, Wallet, Contract, formatEther } from "ethers";
import { Client, Wallet as XrplWallet } from "xrpl";
import { resolveAddresses } from "../chain/registry.js";
import { AssetManagerClient } from "../chain/asset-manager.js";
import { FdcClient } from "../chain/fdc.js";
import { FdcHubClient } from "../chain/fdc-hub.js";
import { Executor } from "../checkout/executor.js";
import { encodeDirectMintingMemo } from "../memo/encoder.js";

const RPC_URL = process.env.FLARE_RPC_URL ?? "https://coston2-api.flare.network/ext/bc/C/rpc";
const XRPL_WS_URL = process.env.XRPL_WS_URL ?? "wss://s.altnet.rippletest.net:51233";
const XRP_AMOUNT_DROPS = process.env.XRP_AMOUNT_DROPS ?? "1000000"; // 1 XRP
const FDC_POLL_MS = Number(process.env.FDC_POLL_MS ?? 15000);
const FDC_TIMEOUT_MS = Number(process.env.FDC_TIMEOUT_MS ?? 600_000);

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];

function log(step: string, msg: string): void {
  console.log(`\n[step ${step}] ${msg}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const operatorKey = process.env.OPERATOR_PRIVATE_KEY;
  const xrplSeed = process.env.XRPL_CUSTOMER_SEED;

  if (!operatorKey) {
    console.error("ERROR: OPERATOR_PRIVATE_KEY env var is required (the Flare operator wallet that pays gas)");
    process.exit(1);
  }
  if (!xrplSeed) {
    console.error("ERROR: XRPL_CUSTOMER_SEED env var is required (the XRPL wallet that sends the Payment)");
    process.exit(1);
  }

  console.log("=== End-to-End Live Settlement Test (Flow A) ===");
  console.log(`  RPC:      ${RPC_URL}`);
  console.log(`  XRPL:     ${XRPL_WS_URL}`);
  console.log(`  XRP amt:  ${XRP_AMOUNT_DROPS} drops (${Number(XRP_AMOUNT_DROPS) / 1_000_000} XRP)`);

  // --- Step 1: resolve live contract addresses ---
  log("1", "Resolving live contract addresses from FlareContractsRegistry...");
  const addresses = await resolveAddresses(RPC_URL);
  console.log(`  AssetManagerFXRP: ${addresses.assetManagerFXRP}`);
  console.log(`  FXRP token:       ${addresses.fxrpToken}`);

  const provider = new JsonRpcProvider(RPC_URL);
  const operator = new Wallet(operatorKey, provider);
  log("1b", `Operator wallet: ${operator.address}`);
  const balance = await provider.getBalance(operator.address);
  console.log(`  Operator C2FLR balance: ${formatEther(balance)} (must be > 0 for gas)`);

  if (balance === 0n) {
    console.error("ERROR: operator wallet has 0 C2FLR — fund it at https://faucet.flare.network/coston2");
    process.exit(1);
  }

  // --- Step 2: read live fee params ---
  log("2", "Reading live fee params from AssetManager...");
  const assetManager = AssetManagerClient.fromRpc(addresses.assetManagerFXRP, RPC_URL);
  const params = await assetManager.getDirectMintingParams();
  console.log(`  Core Vault (XRPL): ${params.coreVaultXrplAddress}`);
  console.log(`  Fee BIPS:          ${params.feeBIPS}`);
  console.log(`  Minimum fee UBA:   ${params.minimumFeeUBA}`);
  console.log(`  Executor fee UBA:  ${params.executorFeeUBA}`);

  const minFeeDrops = params.minimumFeeUBA; // 1 UBA = 1 drop for FXRP
  if (BigInt(XRP_AMOUNT_DROPS) <= minFeeDrops) {
    console.error(`ERROR: XRP_AMOUNT_DROPS (${XRP_AMOUNT_DROPS}) must exceed minimum fee (${minFeeDrops})`);
    process.exit(1);
  }

  // --- Step 3: merchant address (FXRP recipient) ---
  const merchantFlare = (process.env.MERCHANT_FLARE ?? Wallet.createRandom().address) as `0x${string}`;
  log("3", `Merchant (FXRP recipient): ${merchantFlare}`);

  // --- Step 4: build the direct-minting memo ---
  const memoHex = encodeDirectMintingMemo(merchantFlare);
  log("4", `Direct-minting memo (32 bytes): ${memoHex}`);
  console.log(`  Encodes recipient = ${merchantFlare}`);

  // --- Step 5: submit XRPL Payment ---
  log("5", "Connecting to XRPL testnet + submitting Payment to Core Vault...");
  const xrplClient = new Client(XRPL_WS_URL);
  await xrplClient.connect();
  const customerWallet = XrplWallet.fromSeed(xrplSeed);
  console.log(`  Customer r-address: ${customerWallet.address}`);

  const preparedTx = await xrplClient.autofill({
    TransactionType: "Payment",
    Account: customerWallet.address,
    Destination: params.coreVaultXrplAddress,
    Amount: XRP_AMOUNT_DROPS,
    Memos: [
      {
        Memo: {
          MemoData: memoHex,
        },
      },
    ],
  });

  const signed = customerWallet.sign(preparedTx);
  const txResponse = await xrplClient.submit(signed.tx_blob);
  const txHash = signed.hash;
  console.log(`  XRPL tx hash: ${txHash}`);
  console.log(`  Submit result: ${txResponse.result.engine_result} — ${txResponse.result.engine_result_message}`);

  if (txResponse.result.engine_result !== "tesSUCCESS") {
    console.error("ERROR: XRPL Payment did not succeed — check the customer wallet has enough XRP");
    await xrplClient.disconnect();
    process.exit(1);
  }

  // --- Step 6: wait for ledger close ---
  log("6", "XRPL Payment submitted. Waiting for ledger confirmation...");
  // Poll until the XRPL tx is in a validated ledger (testnet closes ~every 4s).
  let validated = false;
  for (let i = 0; i < 30; i++) {
    await sleep(4000);
    const txResult = await xrplClient.request({ command: "tx", transaction: txHash });
    console.log(`  Ledger index: ${txResult.result.ledger_index ?? "pending"}, Validated: ${txResult.result.validated ?? false}`);
    if (txResult.result.validated) {
      validated = true;
      break;
    }
  }
  if (!validated) {
    console.error("ERROR: XRPL tx did not validate within 120s");
    await xrplClient.disconnect();
    process.exit(1);
  }
  await xrplClient.disconnect();

  // --- Step 7: prepare + submit FDC attestation request on-chain ---
  log("7", "Preparing + submitting FDC attestation via FdcHub.requestAttestation()...");
  const deadline = Date.now() + FDC_TIMEOUT_MS;
  const fdc = new FdcClient();
  // The verifier may need a few seconds to index the XRPL tx after validation.
  let prepared;
  for (let i = 0; i < 20; i++) {
    try {
      prepared = await fdc.prepareXrpPaymentProof(txHash, operator.address, true);
      break;
    } catch (e) {
      const msg = (e as Error).message;
      console.log(`  ... verifier not ready yet (${msg.slice(0, 80)}). Retrying in 10s...`);
      await sleep(10000);
    }
  }
  if (!prepared) {
    console.error("ERROR: FDC verifier could not prepare the attestation after 200s");
    process.exit(1);
  }
  console.log(`  Prepared request: ${prepared.abiEncodedRequest.slice(0, 60)}...`);
  const fdcHub = new FdcHubClient({
    rpcUrl: RPC_URL,
    fdcHubAddress: addresses.fdcHub,
    feeConfigAddress: addresses.fdcRequestFeeConfigurations,
    relayAddress: addresses.relay,
    flareSystemsManagerAddress: addresses.flareSystemsManager,
    privateKey: operatorKey,
  });
  const fee = await fdcHub.getRequestFee(prepared.abiEncodedRequest);
  console.log(`  Attestation fee: ${fee} wei (${formatEther(fee)} C2FLR)`);
  const submission = await fdcHub.submitAttestation(prepared.abiEncodedRequest);
  console.log(`  ✓ Attestation submitted! Flare tx: ${submission.flareTxHash}`);
  console.log(`  Block ${submission.blockNumber} (ts ${submission.blockTimestamp}), FDC round ${submission.roundId}`);

  // --- Step 8: poll Relay.isFinalized until the FDC round finalizes ---
  log("8", `Polling Relay.isFinalized(200, round ${submission.roundId})...`);
  console.log("  (FDC rounds finalize ~90–180s after submission.)");
  // The attestation proof lives in the submission round's Merkle tree — keep
  // polling THAT specific round until the Relay contract marks it finalized.
  let finalizedRound = 0;
  while (Date.now() < deadline) {
    const ok = await fdcHub.isFinalized(submission.roundId);
    if (ok) {
      finalizedRound = submission.roundId;
      console.log(`  ✓ FDC round ${submission.roundId} finalized!`);
      break;
    }
    process.stdout.write(`  ... round ${submission.roundId} not finalized yet. Retrying in ${FDC_POLL_MS / 1000}s\n`);
    await sleep(FDC_POLL_MS);
  }
  if (!finalizedRound) {
    console.error(`\nERROR: FDC round ${submission.roundId} did not finalize within ${FDC_TIMEOUT_MS / 1000}s.`);
    process.exit(1);
  }

  // --- Step 9: fetch the Merkle proof from the DA layer ---
  log("9", `Fetching Merkle proof from DA layer (round ${finalizedRound})...`);
  const executor = new Executor({
    rpcUrl: RPC_URL,
    assetManagerAddress: addresses.assetManagerFXRP,
    fdc,
    proofOwner: operator.address,
    privateKey: operatorKey,
    dryRun: false,
  });
  let proof;
  // The DA layer API can lag ~30–60s behind on-chain Relay finalization.
  // Retry with backoff until the proof is available.
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      proof = await fdc.getProof(finalizedRound, prepared.abiEncodedRequest);
      console.log(`  ✓ Proof fetched! ${proof.proof.length} Merkle siblings, data=${proof.data.slice(0, 40)}...`);
      break;
    } catch (e) {
      console.log(`  ... proof not indexed yet (attempt ${attempt}/10): ${((e as Error).message).slice(0, 60)}`);
      if (attempt < 10) await sleep(30000);
    }
  }
  if (!proof) {
    console.error(`  ✗ Proof fetch failed after 10 retries (~5 min)`);
    process.exit(1);
  }

  // --- Step 10: call executeDirectMinting on Flare ---
  log("10", "Submitting executeDirectMinting on Flare (operator pays gas)...");
  // NOTE: an executor bot may race us to the minting (anyone can call
  // executeDirectMinting and earn the executor fee). PaymentAlreadyConfirmed
  // (0x18dce79f) means the mint already happened — the merchant still gets
  // their FXRP, just minted by someone else. Treat this as success.
  const result = await executor.executeDirectMinting(proof);
  if (!result.ok || !result.flareTxHash) {
    if (result.error?.includes("18dce79f") || result.error?.includes("PaymentAlreadyConfirmed")) {
      console.log("  ⚡ PaymentAlreadyConfirmed — an executor bot minted first; merchant still receives FXRP");
    } else {
      console.error(`  ✗ executeDirectMinting failed: ${result.error}`);
      process.exit(1);
    }
  } else {
    console.log(`  ✓ Flare tx confirmed: ${result.flareTxHash}`);
  }

  // --- Step 11: verify FXRP balance ---
  log("11", "Verifying FXRP minted to merchant address...");
  const fxrp = new Contract(addresses.fxrpToken, ERC20_ABI, provider);
  const merchantBalance = await fxrp.balanceOf(merchantFlare);
  const decimals = await fxrp.decimals();
  console.log(`  Merchant FXRP balance: ${merchantBalance} (decimals=${decimals})`);

  if (merchantBalance > 0n) {
    console.log(`  ✓✓✓ SUCCESS: FXRP minted to merchant via real FDC proof + on-chain executeDirectMinting`);
  } else {
    console.error("  ✗ Merchant balance is 0 — the mint may have credited to a different address");
    process.exit(1);
  }

  // --- Summary ---
  console.log("\n=== E2E Test Complete ===");
  console.log(`  XRPL tx:   ${txHash}`);
  console.log(`  Flare tx:  ${result.flareTxHash}`);
  console.log(`  Attest tx: ${submission.flareTxHash}`);
  console.log(`  FDC round: ${finalizedRound}`);
  console.log(`  Merchant: ${merchantFlare}`);
  console.log(`  FXRP minted: ${merchantBalance} (raw)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

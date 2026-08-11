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
 *   1. Resolve live contract addresses (AssetManager, FXRP token, Core Vault)
 *   2. Read live fee params (minimum fee, fee BIPS, executor fee)
 *   3. Generate (or use env) merchant Flare address — the FXRP recipient
 *   4. Build the direct-minting memo: 0x4642505266410018 + zeros + merchant
 *   5. Submit an XRPL Payment from the customer wallet to the Core Vault
 *   6. Print the XRPL tx hash and wait for ledger close
 *   7. Poll the FDC DA layer until the proof is finalized (getLatestProof)
 *   8. Call executeDirectMinting(proof) via the operator wallet (real gas)
 *   9. Wait for the Flare tx to confirm
 *  10. Verify: FXRP.balanceOf(merchant) > 0
 */

import { JsonRpcProvider, Wallet, Contract, formatEther } from "ethers";
import { Client, Wallet as XrplWallet } from "xrpl";
import { resolveAddresses } from "../chain/registry.js";
import { AssetManagerClient } from "../chain/asset-manager.js";
import { FdcClient } from "../chain/fdc.js";
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

  const prepared = await xrplClient.autofill({
    TransactionType: "Payment",
    Account: customerWallet.address,
    Destination: params.coreVaultXrplAddress,
    Amount: XRP_AMOUNT_DROPS,
    Memos: [
      {
        Memo: {
          MemoType: "4642505266410018", // direct-minting prefix as MemoType
          MemoData: memoHex,
        },
      },
    ],
  });

  const signed = customerWallet.sign(prepared);
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
  await sleep(4000); // XRPL testnet closes a ledger every ~4s
  const txResult = await xrplClient.request({ command: "tx", transaction: txHash });
  console.log(`  Ledger index: ${txResult.result.ledger_index ?? "pending"}`);
  console.log(`  Validated:     ${txResult.result.validated ?? false}`);
  await xrplClient.disconnect();

  // --- Step 7: poll FDC until proof is finalized ---
  log("7", `Polling FDC DA layer for attestation finalization (every ${FDC_POLL_MS}ms, timeout ${FDC_TIMEOUT_MS / 1000}s)...`);
  console.log("  (The FDC attestation typically finalizes 90–180s after the XRPL tx.)");

  const fdc = new FdcClient();
  const executor = new Executor({
    rpcUrl: RPC_URL,
    assetManagerAddress: addresses.assetManagerFXRP,
    fdc,
    proofOwner: operator.address, // the executor is the proof owner
    privateKey: operatorKey,
    dryRun: false, // LIVE — will broadcast
  });

  const deadline = Date.now() + FDC_TIMEOUT_MS;
  let proof = null;
  while (Date.now() < deadline) {
    try {
      proof = await executor.fetchProof(txHash, true);
      console.log(`  ✓ FDC proof finalized! Round ${proof.roundId}, ${proof.proof.length} Merkle siblings`);
      break;
    } catch (e) {
      const msg = (e as Error).message;
      process.stdout.write(`  ... not finalized yet (${msg.slice(0, 80)}). Retrying in ${FDC_POLL_MS / 1000}s\r`);
      await sleep(FDC_POLL_MS);
    }
  }

  if (!proof) {
    console.error(`\nERROR: FDC proof did not finalize within ${FDC_TIMEOUT_MS / 1000}s. Try again later.`);
    process.exit(1);
  }

  // --- Step 8: call executeDirectMinting on Flare ---
  log("8", "Submitting executeDirectMinting on Flare (operator pays gas)...");
  const result = await executor.executeDirectMinting(proof);
  if (!result.ok || !result.flareTxHash) {
    console.error(`  ✗ executeDirectMinting failed: ${result.error}`);
    process.exit(1);
  }
  console.log(`  ✓ Flare tx confirmed: ${result.flareTxHash}`);

  // --- Step 9: verify FXRP balance ---
  log("9", "Verifying FXRP minted to merchant address...");
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
  console.log(`  XRPL tx:  ${txHash}`);
  console.log(`  Flare tx: ${result.flareTxHash}`);
  console.log(`  FDC round: ${proof.roundId}`);
  console.log(`  Merchant:  ${merchantFlare}`);
  console.log(`  FXRP minted: ${merchantBalance} (raw)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

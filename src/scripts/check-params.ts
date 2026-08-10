/**
 * Phase 0 live validation script — verifies all Coston2 clients work against the
 * real testnet, reading every parameter live from the chain (never hardcoded).
 *
 * Read-only: sends NO transactions. Validates:
 *   1. FlareContractsRegistry resolves AssetManagerFXRP + FXRP token
 *   2. AssetManager returns Core Vault address, fees, MintingTagManager
 *   3. FTSO returns a non-stale XRP/USD price
 *   4. XRPL watcher connects to testnet and can query the Core Vault
 *
 * Usage: npx tsx src/scripts/check-params.ts
 *        (set FLARE_RPC_URL / XRPL_WS_URL to override Coston2 defaults)
 */
import { resolveAddresses } from "../chain/registry.js";
import { AssetManagerClient } from "../chain/asset-manager.js";
import { FtsoClient } from "../chain/ftso.js";
import { XrplWatcher } from "../chain/xrpl-watcher.js";

const rpcUrl = process.env.FLARE_RPC_URL ?? "https://coston2-api.flare.network/ext/bc/C/rpc";
const xrplWsUrl = process.env.XRPL_WS_URL ?? "wss://s.altnet.rippletest.net:51233";

function ok(label: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${label}`);
}
function warn(label: string) {
  console.log(`  \x1b[33m⚠\x1b[0m ${label}`);
}
function fail(label: string) {
  console.log(`  \x1b[31m✗\x1b[0m ${label}`);
}

async function main() {
  console.log("\n=== Phase 0 — Coston2 live param validation ===\n");
  console.log(`Flare RPC : ${rpcUrl}`);
  console.log(`XRPL WS   : ${xrplWsUrl}\n`);

  // 1. Registry resolution
  console.log("[1/4] FlareContractsRegistry → resolve addresses");
  let addresses;
  try {
    addresses = await resolveAddresses(rpcUrl);
    ok(`AssetManagerFXRP : ${addresses.assetManagerFXRP}`);
    ok(`FXRP token       : ${addresses.fxrpToken}`);
  } catch (e) {
    fail(`Registry resolution failed: ${(e as Error).message}`);
    process.exit(1);
  }

  // 2. AssetManager params
  console.log("\n[2/5] AssetManager → direct-minting params");
  let params;
  try {
    const am = AssetManagerClient.fromRpc(addresses.assetManagerFXRP, rpcUrl);
    params = await am.getDirectMintingParams();
    ok(`Core Vault XRPL addr  : ${params.coreVaultXrplAddress}`);
    ok(`Minimum mint fee (UBA): ${params.minimumFeeUBA.toString()}`);
    ok(`Minting fee BIPS      : ${params.feeBIPS.toString()}`);
    ok(`Executor fee (UBA)     : ${params.executorFeeUBA.toString()}`);
    ok(`Others exec after (s) : ${params.othersCanExecuteAfterSeconds.toString()}`);
    ok(`Hourly limit (UBA)    : ${params.hourlyLimitUBA.toString()}`);
    ok(`Daily limit  (UBA)    : ${params.dailyLimitUBA.toString()}`);
    ok(`MintingTagManager     : ${params.mintingTagManager}`);
    ok(`redeemWithTagSupported: ${params.redeemWithTagSupported}`);
  } catch (e) {
    fail(`AssetManager read failed: ${(e as Error).message}`);
    process.exit(1);
  }

  // 2b. Redemption params (Phase 2)
  console.log("\n[3/5] AssetManager → redemption params (Flow B)");
  try {
    const am = AssetManagerClient.fromRpc(addresses.assetManagerFXRP, rpcUrl);
    const r = await am.getRedemptionParams();
    ok(`Minimum redeem amount (UBA): ${r.minimumRedeemAmountUBA.toString()}`);
    ok(`Redemption fee BIPS         : ${r.redemptionFeeBIPS.toString()}`);
    ok(`Minimum redeem lots        : ${r.minimumRedeemLots.toString()}`);
  } catch (e) {
    fail(`Redemption params read failed: ${(e as Error).message}`);
  }

  // 3. FTSO price
  console.log("\n[4/5] FTSO → XRP/USD + FLR/USD feeds");
  try {
    const ftso = await FtsoClient.create(rpcUrl);
    const xrpUsd = await ftso.getFeed(XRP_USD_FEED_ID_LOCAL());
    const flrUsd = await ftso.getFeed(FLR_USD_FEED_ID_LOCAL());
    ok(`XRP/USD : ${FtsoClient.toDisplayPrice(xrpUsd)} (decimals ${xrpUsd.decimals})`);
    if (xrpUsd.stale) warn("XRP/USD feed is STALE — check FDC round status");
    ok(`FLR/USD : ${FtsoClient.toDisplayPrice(flrUsd)} (decimals ${flrUsd.decimals})`);
    if (flrUsd.stale) warn("FLR/USD feed is STALE");
    // sanity: price > 0
    if (xrpUsd.value === 0n) fail("XRP/USD price is zero — feed not initialized?");
  } catch (e) {
    fail(`FTSO read failed: ${(e as Error).message}`);
  }

  // 4. XRPL watcher
  console.log("\n[5/5] XRPL watcher → connect + query Core Vault");
  let watcher: XrplWatcher | undefined;
  try {
    watcher = new XrplWatcher(xrplWsUrl);
    await watcher.connect();
    ok("Connected to XRPL testnet");
    if (params.coreVaultXrplAddress) {
      const payments = await watcher.getRecentVaultPayments(params.coreVaultXrplAddress, 10);
      ok(`Queried Core Vault (${params.coreVaultXrplAddress}): ${payments.length} recent payments`);
      if (payments.length > 0) {
        const p = payments[0];
        console.log(`       sample tx: ${p.txHash.slice(0, 16)}… tag=${p.destinationTag ?? "none"} drops=${p.amountDrops}`);
      } else {
        warn("No recent payments to the Core Vault (expected on a fresh testnet)");
      }
    }
  } catch (e) {
    fail(`XRPL watcher failed: ${(e as Error).message}`);
  } finally {
    if (watcher) await watcher.disconnect();
  }

  console.log("\n=== Phase 0 validation complete ===\n");
}

// avoid circular import: re-export feed ids locally
import { XRP_USD_FEED_ID, FLR_USD_FEED_ID } from "../chain/ftso.js";
function XRP_USD_FEED_ID_LOCAL() {
  return XRP_USD_FEED_ID;
}
function FLR_USD_FEED_ID_LOCAL() {
  return FLR_USD_FEED_ID;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

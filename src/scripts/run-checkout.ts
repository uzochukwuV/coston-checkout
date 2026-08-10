/**
 * Phase 1 demo runner — wires the checkout service against Coston2 (DRY_RUN).
 *
 * Validates the full Flow A path OFF the broadcast:
 *   - resolve live chain params
 *   - create an order (FTSO quote + tag allocation)
 *   - poll the Core Vault for recent payments
 *   - match payments to open orders
 *   - (dry-run) attempt settlement — prints what it WOULD do
 *   - sign a merchant webhook
 *
 * No PRIVATE_KEY / XRPL_SEED needed. No transactions are broadcast.
 *
 * Usage: npx tsx src/scripts/run-checkout.ts
 */
import { resolveAddresses } from "../chain/registry.js";
import { AssetManagerClient } from "../chain/asset-manager.js";
import { FtsoClient, XRP_USD_FEED_ID } from "../chain/ftso.js";
import { XrplWatcher } from "../chain/xrpl-watcher.js";
import { FdcClient } from "../chain/fdc.js";
import { CheckoutService, type CheckoutConfig } from "../checkout/checkout-service.js";
import { Executor } from "../checkout/executor.js";

const rpcUrl = process.env.FLARE_RPC_URL ?? "https://coston2-api.flare.network/ext/bc/C/rpc";
const xrplWsUrl = process.env.XRPL_WS_URL ?? "wss://s.altnet.rippletest.net:51233";
const merchantFlare = (process.env.MERCHANT_FLARE ?? "0x000000000000000000000000000000000000dEaD") as `0x${string}`;

async function main() {
  console.log("\n=== Phase 1 — Flow A MVP (DRY_RUN) ===\n");

  // resolve live params
  const addresses = await resolveAddresses(rpcUrl);
  const assetManager = AssetManagerClient.fromRpc(addresses.assetManagerFXRP, rpcUrl);
  const params = await assetManager.getDirectMintingParams();
  console.log("Core Vault:", params.coreVaultXrplAddress);
  console.log("Fees: bips=" + params.feeBIPS + " min=" + params.minimumFeeUBA + " exec=" + params.executorFeeUBA);

  // wire clients
  const ftso = await FtsoClient.create(rpcUrl);
  const xrpUsd = await ftso.getFeed(XRP_USD_FEED_ID);
  console.log("XRP/USD:", FtsoClient.toDisplayPrice(xrpUsd), "(stale=" + xrpUsd.stale + ")");

  const watcher = new XrplWatcher(xrplWsUrl);
  await watcher.connect();

  const fdc = new FdcClient();
  const executor = new Executor({
    rpcUrl,
    assetManagerAddress: addresses.assetManagerFXRP,
    fdc,
    proofOwner: merchantFlare,
    dryRun: true,
  });

  const cfg: CheckoutConfig = {
    merchantId: "demo-merchant",
    merchantFlareAddress: merchantFlare,
    webhookUrl: undefined,
    webhookSecret: "demo-secret",
  };
  const svc = new CheckoutService(cfg, ftso, watcher, executor, assetManager);

  // create an order
  console.log("\n--- create order ($10) ---");
  const order = await svc.createOrder({ usdAmount: 10 });
  console.log(JSON.stringify(order, (_k, v) => (typeof v === "bigint" ? v.toString() + "n" : v), 2));

  // poll + match (no tag allocated since pool is empty — expected)
  console.log("\n--- poll core vault ---");
  const settled = await svc.pollAndMatch();
  console.log("settled:", settled.length, "(expected 0: empty tag pool / dry-run)");

  // expire stale
  const expired = svc.expireStale(order.quote.expiresAt + 1);
  console.log("expired:", expired.length);

  await watcher.disconnect();
  console.log("\n=== Phase 1 demo complete ===\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

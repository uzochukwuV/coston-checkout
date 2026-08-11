/**
 * Production-style server entry point.
 *
 * Wires the full checkout service against live Coston2 with:
 *   - SQLite-backed order persistence (survives restarts)
 *   - background polling loop (auto payment detection + settlement)
 *   - HTTP API on PORT (default 3000)
 *
 * Env:
 *   FLARE_RPC_URL       Flare RPC (default: Coston2)
 *   XRPL_WS_URL         XRPL websocket (default: testnet)
 *   MERCHANT_FLARE      merchant Flare address
 *   MERCHANT_XRPL       merchant XRPL address (Flow B; optional)
 *   WEBHOOK_URL         merchant webhook URL (optional)
 *   WEBHOOK_SECRET      HMAC secret for webhooks
 *   DB_PATH             SQLite path (default: orders.db)
 *   PORT                HTTP port (default: 3000)
 *   POLL_INTERVAL_MS    polling loop interval (default: 5000)
 *   DRY_RUN             "false" to broadcast transactions (default: true)
 *   PRIVATE_KEY         operator wallet key (required when DRY_RUN=false)
 *
 * Usage: npx tsx src/scripts/serve.ts
 */

import { resolveAddresses } from "../chain/registry.js";
import { AssetManagerClient } from "../chain/asset-manager.js";
import { FtsoClient } from "../chain/ftso.js";
import { XrplWatcher } from "../chain/xrpl-watcher.js";
import { FdcClient } from "../chain/fdc.js";
import { CheckoutService, type CheckoutConfig } from "../checkout/checkout-service.js";
import { Executor } from "../checkout/executor.js";
import { SqliteOrderStore } from "../checkout/order-store-sqlite.js";
import { createApiServer } from "../api/server.js";

async function main() {
  const rpcUrl = process.env.FLARE_RPC_URL ?? "https://coston2-api.flare.network/ext/bc/C/rpc";
  const xrplWsUrl = process.env.XRPL_WS_URL ?? "wss://s.altnet.ripplettest.net:51233";
  const merchantFlare = (process.env.MERCHANT_FLARE ?? "0x000000000000000000000000000000000000dEaD") as `0x${string}`;
  const port = Number(process.env.PORT ?? 3000);
  const dbPath = process.env.DB_PATH ?? "orders.db";
  const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 5000);
  const dryRun = process.env.DRY_RUN !== "false";

  console.log(`=== fxrp-checkout server (${dryRun ? "DRY_RUN" : "LIVE"}) ===`);
  console.log(`  RPC:   ${rpcUrl}`);
  console.log(`  XRPL:  ${xrplWsUrl}`);
  console.log(`  DB:    ${dbPath}`);
  console.log(`  Port:  ${port}`);
  console.log(`  Poll:  every ${pollIntervalMs}ms`);

  // resolve live chain params
  const addresses = await resolveAddresses(rpcUrl);
  const assetManager = AssetManagerClient.fromRpc(addresses.assetManagerFXRP, rpcUrl);
  const ftso = await FtsoClient.create(rpcUrl);
  const watcher = new XrplWatcher(xrplWsUrl);
  // Try to connect upfront, but don't block startup — the polling loop will
  // retry via getRecentVaultPayments → connect() on each cycle if it fails.
  try {
    await watcher.connect();
    console.log("  XRPL watcher: connected");
  } catch (e) {
    console.warn(`  XRPL watcher: initial connect failed (${(e as Error).message}); will retry in polling loop`);
  }
  const fdc = new FdcClient();
  const executor = new Executor({
    rpcUrl,
    assetManagerAddress: addresses.assetManagerFXRP,
    fdc,
    proofOwner: merchantFlare,
    dryRun,
  });

  const cfg: CheckoutConfig = {
    merchantId: process.env.MERCHANT_ID ?? "default",
    merchantFlareAddress: merchantFlare,
    merchantXrplAddress: process.env.MERCHANT_XRPL,
    merchantXrplDestinationTag: process.env.MERCHANT_XRPL_TAG ? Number(process.env.MERCHANT_XRPL_TAG) : undefined,
    webhookUrl: process.env.WEBHOOK_URL,
    webhookSecret: process.env.WEBHOOK_SECRET ?? "default-secret",
  };

  const store = new SqliteOrderStore(dbPath);
  const svc = new CheckoutService(cfg, ftso, watcher, executor, assetManager, undefined, store);

  const server = createApiServer(svc, {
    port,
    polling: {
      enabled: true,
      intervalMs: pollIntervalMs,
      onCycle: (r) => {
        if (r.settled > 0 || r.expired > 0 || r.error) {
          console.log(
            `[poll #${r.cycle}] settled=${r.settled} expired=${r.expired} ${r.durationMs}ms${r.error ? " err=" + r.error : ""}`,
          );
        }
      },
    },
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`\n  → http://0.0.0.0:${port}`);
    console.log(`  → GET  /healthz`);
    console.log(`  → POST /orders        { usdAmount }`);
    console.log(`  → GET  /orders/:id`);
    console.log(`  → GET  /orders`);
    console.log(`\n  Background polling loop active. Settlement is automatic.`);
  });

  const shutdown = async () => {
    console.log("\nShutting down...");
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await watcher.disconnect();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

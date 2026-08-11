# fxrp-checkout

Gasless FXRP merchant checkout on Flare. A customer pays XRP on XRPL and never
holds FLR or touches an EVM wallet; an operator relayer sponsors all Flare-side
gas and settles the payment on-chain.

Built on four enshrined Flare protocols:

- **FAssets** — trustless over-collateralized bridge (XRPL → FXRP ERC-20)
- **FDC** — Flare Data Connector, verifies XRPL payments via Merkle attestations
- **FTSO** — decentralized price feeds for collateral / quote valuation
- **Smart Accounts** — XRPL→Flare account abstraction (Flow C atomic actions)

---

## How it works

A merchant wants to be paid in FXRP (or XRP). The customer has only an XRPL
wallet. The checkout service bridges the two without the customer ever touching
Flare:

```
Customer (XRPL)                    Operator (Flare relayer)                Merchant
      |                                    |                                   |
      |  1. POST /orders { usdAmount }     |                                   |
      |------------------------->----------|                                   |
      |  2. quote: XRP amount + memo/tag   |                                   |
      |<-----------------------------------|                                   |
      |                                    |                                   |
      |  3. XRPL Payment to Core Vault     |                                   |
      |    (memo or destination tag)       |                                   |
      |-------------------.                |                                   |
      |                   '---> Core Vault |                                   |
      |                                    |  4. poll XRPL, match to order     |
      |                                    |  5. fetch FDC proof (finalize)    |
      |                                    |  6. executeDirectMinting(proof)   |
      |                                    |-----> FXRP minted on Flare ------->|
      |                                    |  7. signed webhook (HMAC-SHA256)   |
      |                                    |---------------------------------->|
```

The customer's single XRPL Payment encodes the order binding via either a
**destination tag** (MintingTagManager NFT) or a **binary memo**. The operator
monitors the Core Vault, fetches an FDC attestation proving the payment, and
submits `executeDirectMinting` on Flare — which verifies the proof on-chain
before minting FXRP.

---

## Three settlement flows

### Flow A — settle-to-FXRP (default)

Mint FXRP directly to the merchant's Flare address. Simplest path.

```
CREATED → AWAITING_PAYMENT → PAYMENT_DETECTED → SETTLING → SETTLED
CREATED → EXPIRED | FAILED
```

The customer sends an XRPL Payment with a destination tag (allocated from a
MintingTagManager tag pool) or a `0x4642505266410018` direct-minting memo
encoding the recipient. The executor calls `executeDirectMinting(proof)`; FXRP
lands in the merchant's EOA.

### Flow B — settle-to-XRP (redeemWithTag)

Mint FXRP to the operator, then redeem it back to XRP at the merchant's XRPL
address (with a destination tag for exchanges). Used when the merchant wants
XRP, not FXRP.

```
... → SETTLING → MINTED → REDEEMING → REDEEMED
                    REDEEMING → REDEEM_DEFAULTED → (REDEEMING retry | REFUNDED | FAILED)
```

After minting, the operator approves FXRP and calls
`redeemWithTag(amount, xrplAddress, executor, tag)`. An FAssets agent pays out
XRP on XRPL. If the agent misses the payout deadline, the service retries (up to
`maxRedeemAttempts`) or refunds the customer.

### Flow C — atomic mint + user op (AUTO)

Mint FXRP to the customer's **Smart Account** and execute a post-mint action in
a single atomic transaction via `executeDirectMintingWithData`. If the action
reverts, no FXRP is minted — the XRP stays at the Core Vault (recoverable via
the `0xE0` skip-memo).

```
... → SETTLING → SETTLED   (mint + user op succeed together)
... → SETTLING → FAILED    (any revert rolls back the mint)
```

The customer commits to a `PackedUserOperation` by placing its `keccak256` hash
in a `0xFE` custom-instruction memo (42 bytes). The executor supplies the full
ABI-encoded user op as the `_data` argument. The on-chain contract verifies
`keccak256(data) == memoHash`, mints FXRP to the personal account, then
dispatches `executeUserOp(Call[])`.

Supported post-mint actions (`OrderAction.kind`):

| Kind       | What it does                                         |
|------------|------------------------------------------------------|
| `transfer` | `FXRP.transfer(merchant, amount)` — route to merchant |
| `deposit`  | `vault.deposit(amount)` — drop into a yield vault    |
| `swap`     | DEX call with pre-encoded calldata                   |
| `raw`      | arbitrary single contract call                       |

---

## Architecture

```
src/
  api/
    server.ts              HTTP API (node:http, no framework)
  chain/
    registry.ts            Resolve AssetManagerFXRP + FXRP from FlareContractsRegistry
    asset-manager.ts       Live fee params, Core Vault address, MintingTagManager
    ftso.ts                XRP/USD + FLR/USD price feeds (FtsoV2)
    fdc.ts                 FDC XRPPayment attestations + Merkle proofs + round discovery
    xrpl-watcher.ts        Core Vault payment monitoring (account_tx)
  checkout/
    checkout-service.ts    Orchestration: create → match → settle → webhook
    order.ts               Order model, quote, state machine
    pricing.ts             USD → XRP (drops) with slippage + service fee
    executor.ts            executeDirectMinting / executeDirectMintingWithData
    redeemer.ts            redeemWithTag (Flow B)
    matcher.ts             Match XRPL payments to orders (tag or 0xFE memo)
    userop.ts              PackedUserOperation builder (Flow C)
    actions.ts             Call[] builders for Flow C actions
    tag-pool.ts            MintingTagManager destination-tag allocator
    order-store.ts         In-memory order persistence
    refund.ts              Refund/retry policy (pure decisions)
    webhook.ts             HMAC-SHA256 signed webhooks
  memo/
    encoder.ts             Binary memo encoder/decoder (4 formats)
  scripts/
    check-params.ts        Live Coston2 validation (read-only)
    run-checkout.ts        Flow A demo (DRY_RUN)
    run-checkout-b.ts      Flow B demo (DRY_RUN)
    run-checkout-c.ts      Flow C demo (DRY_RUN)
```

### Design principles

- **Gasless for the customer.** The customer sends one XRPL Payment. The
  operator pays all FLR gas and recovers it via the executor fee.
- **Live, never hardcoded.** Contract addresses resolve from
  FlareContractsRegistry; fee params, Core Vault address, and FTSO prices are
  read from the chain at runtime. No mainnet/testnet address constants.
- **Proofs are the trust root.** XRPL memo/tag/amount are untrusted until the
  FDC attestation confirms them on-chain. The on-chain contract is the
  authoritative validator.
- **DRY_RUN by default.** No transaction is broadcast unless `DRY_RUN=false`
  and a `PRIVATE_KEY` is set. Demo runners use stubbed executors.
- **Pure business logic.** Pricing, matching, refund policy, and memo encoding
  are pure functions — unit-tested without network access.

---

## Memo formats

The XRPL `MemoData` field (hex, no `0x` prefix) encodes the order binding:

| Format | Prefix (8 bytes)     | Size  | Purpose                              |
|--------|----------------------|-------|--------------------------------------|
| Direct minting     | `4642505266410018` | 32 B | Recipient Flare address              |
| Direct minting EX  | `4642505266410021` | 48 B | Recipient + executor                 |
| `0xFE` custom      | `fe...`            | 42 B | Hash-commit to a PackedUserOperation |
| `0xFF` custom      | `ff...`            | var  | Inline PackedUserOperation           |

For Flows A/B, a **destination tag** (MintingTagManager NFT) can be used
instead of a memo — useful for XRPL wallets that don't support memos.

---

## Quick start

### Prerequisites

- Node.js 22+
- npm install

### Run the live validation

Verifies all chain clients against Coston2 (read-only, no broadcast):

```bash
npx tsx src/scripts/check-params.ts
```

Output confirms: registry resolution, AssetManager fees, FTSO prices, XRPL
watcher connectivity.

### Run a demo

```bash
# Flow A — settle-to-FXRP
npx tsx src/scripts/run-checkout.ts

# Flow B — settle-to-XRP (redeemWithTag)
npx tsx src/scripts/run-checkout-b.ts

# Flow C — atomic mint + user op
npx tsx src/scripts/run-checkout-c.ts
```

All demos run in DRY_RUN mode against live Coston2 — no `PRIVATE_KEY` needed.

### Run the tests

```bash
npm test
```

167 tests across 13 files. The FDC tests hit the live Coston2 DA Layer and
auto-skip when offline.

---

## Configuration

### Environment variables

| Variable              | Default (Coston2)                                        | Purpose                        |
|-----------------------|----------------------------------------------------------|--------------------------------|
| `FLARE_RPC_URL`       | `https://coston2-api.flare.network/ext/bc/C/rpc`        | Flare RPC endpoint             |
| `XRPL_WS_URL`         | `wss://s.altnet.rippletest.net:51233`                   | XRPL websocket (testnet)       |
| `MERCHANT_FLARE`      | `0x…dEaD`                                                | Merchant Flare address (demo)  |
| `PERSONAL_ACCOUNT`    | `0x…BEEF`                                                | Smart account address (Flow C) |
| `FXRP_TOKEN`          | resolved from registry                                   | FXRP ERC-20 address override   |
| `DRY_RUN`             | `true`                                                   | Set `false` to broadcast       |
| `PRIVATE_KEY`         | —                                                        | Operator wallet (to broadcast) |

### CheckoutConfig

```typescript
const cfg: CheckoutConfig = {
  merchantId: "acme",
  merchantFlareAddress: "0x…",
  merchantXrplAddress: "r…",           // Flow B only
  merchantXrplDestinationTag: 12345,   // Flow B only
  webhookUrl: "https://merchant.app/hook",
  webhookSecret: "shared-secret",
  slippageBps: 100,       // 1%
  serviceFeeBps: 50,       // 0.5%
  expirySeconds: 900,      // 15 min
  maxRedeemAttempts: 3,    // Flow B
};
```

---

## HTTP API

| Method | Path               | Body                          | Returns                        |
|--------|--------------------|-------------------------------|--------------------------------|
| GET    | `/healthz`         | —                             | `{ ok: true }`                 |
| POST   | `/orders`          | `{ usdAmount }`               | Order + quote                  |
| GET    | `/orders/:id`      | —                             | Order status                   |
| GET    | `/orders`          | —                             | All open orders                |
| POST   | `/admin/poll`      | —                             | Poll + match payments          |
| POST   | `/admin/expire`    | —                             | Expire stale orders            |

### Webhooks

On settlement, the service POSTs a signed payload to `webhookUrl`:

```
X-Checkout-Signature: <hmac-sha256 hex>
X-Checkout-Timestamp: <unix seconds>

{
  "orderId": "ord_000001",
  "flareTxHash": "0x…",
  "fdcAttestationId": "…",
  "fxrpSettled": "9826930",
  "status": "SETTLED",
  "settlementMode": "FXRP",
  "feeBreakdown": { … }
}
```

Verify with `verifyWebhook(signed, secret)` (constant-time, 5-min replay window).

---

## Fee model

```
customerXrpDrops = baseXrp (USD→XRP via FTSO) + serviceFee + slippageBuffer
mintFeeDrops     = max(baseXrp * feeBIPS / 10000, minimumFeeUBA) + executorFeeUBA
fxrpMintedDrops  = customerXrpDrops - mintFeeDrops
operatorFeeDrops = customerXrpDrops * serviceFeeBps / 10000
```

Flow A: merchant receives `fxrpMintedDrops` (no redeem fee).
Flow B: merchant receives `fxrpMintedDrops - redeemFeeDrops` in XRP.
Flow C: same as Flow A (the action moves FXRP within the same tx).

All fee parameters are read live from `AssetManager` at runtime.

---

## Security

- **No keys in code.** `PRIVATE_KEY` / `XRPL_SEED` are env-only, never logged.
- **Untrusted XRPL data.** Memo bytes, destination tags, and amounts are
  treated as untrusted until the FDC proof confirms them on-chain.
- **On-chain verification.** `executeDirectMinting` re-verifies the Merkle
  proof; the contract is the authority, not the off-chain API response.
- **Flow C trust root.** The user-op data is operator-built; the on-chain
  `keccak256(data) == memoHash` check is what makes it binding. The customer's
  XRPL Payment (with the `0xFE` memo) authorizes the specific user op.
- **Webhook integrity.** HMAC-SHA256 with constant-time comparison and a
  replay window.

---

## Project status

| Phase | Flow                          | Status      |
|-------|-------------------------------|-------------|
| 0     | Skeleton + memo + chain clients | ✅ Done  |
| 1     | Flow A — settle-to-FXRP       | ✅ Done     |
| 2     | Flow B — settle-to-XRP        | ✅ Done     |
| 3     | Flow C — atomic mint + user op | ✅ Done    |

**Network:** Coston2 testnet. Mainnet deployment requires reading all parameters
live (the code already does this) and funding an operator wallet with FLR.

**License:** Private.

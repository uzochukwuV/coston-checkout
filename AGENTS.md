# Flare FXRP Merchant Checkout ‚Äî Project Memory

## Installed skills (from flare-foundation/flare-ai-skills)
- `.agents/skills/flare-fassets-skill/` ‚Äî FAssets/FXRP minting, redemption, Core Vault, MintingTagManager
- `.agents/skills/flare-smart-accounts-skill/` ‚Äî XRPL‚ÜíFlare account abstraction, custom instructions
- `.agents/skills/flare-fdc-skill/` ‚Äî FDC attestations (XRPPayment proof-of-payment)
- `.agents/skills/flare-ftso-skill/` ‚Äî FTSO price feeds
- `.agents/skills/flare-general-skill/` ‚Äî general Flare/networks/tooling

## Verified key interfaces (grounding the checkout design)

### Direct minting (the mint path)
- Memo 32-byte: `0x4642505266410018` (8B prefix) + `00000000` (4B zero) + 20B recipient = 32B. No orderId room.
- Memo 48-byte: `0x4642505266410021` prefix + 20B recipient + 20B executor.
- Core Vault XRPL address: read live via `AssetManager.directMintingPaymentAddress()` ‚Äî NEVER hardcode.
- Entrypoints: `executeDirectMinting(IXRPPayment.Proof)`, `executeDirectMintingWithData(IXRPPayment.Proof, bytes data)`.
- Fees (read live): `getDirectMintingMinimumFeeUBA()`, `getDirectMintingFeeBIPS()`, `getDirectMintingExecutorFeeUBA()`. Both minting fee + executor fee deducted from the XRP payment.

### MintingTagManager (order-binding via destination tag)
- `reserve()` payable ‚Üí tag NFT (32-bit, fits XRPL DestinationTag).
- `setMintingRecipient(tagId, recipient)` ‚Äî owner only. 10-min cooldown on changes.
- `setAllowedExecutor(tagId, executor)` ‚Äî 10-min cooldown; cleared on transfer.
- `transfer`/`transferFrom` reset recipient + clear executor; tag ID unchanged.
- Reusable across payments. Good for tag-pool order binding.

### Smart Accounts + gasless
- **NO EIP-4337 paymaster.** `PackedUserOperation.paymasterAndData = "0x"`, not validated on-chain.
- Gas is sponsored by the **operator/executor/relayer paying FLR**. The XRPL user never touches FLR.
- `executeUserOp(Call[])` on PersonalAccount; `Call = {target, value, data}`.
- `executeDirectMintingWithData(proof, data)` is **fully atomic**: mints FXRP + runs user op in one tx; reverts = no FXRP minted.
- Custom instruction `0xFE`: 42-byte memo = `[0xFE][walletId(1B)][executorFeeUBA(8B BE)][keccak256(PackedUserOperation)(32B)]`. Full userOp delivered off-chain to executor.
- Custom instruction `0xFF`: memo = `[0xFF][walletId][executorFeeUBA(8B)][abi.encode(PackedUserOperation)]` inline (‚â§1024B XRPL memo cap).
- Fee-only mint (`netMintAmountXrp: 0`) dispatches a user op without minting FXRP ‚Äî for moving existing ERC-20 balances.
- `getNonce(personalAccount)` must match `PackedUserOperation.nonce`; read once per XRPL payment.
- Recovery opcodes: `0xE0` skip memo, `0xE1` fast-forward nonce, `0xE2` replace executor fee.

### FDC XRPPayment (payment proof = trust root)
- Request: `transactionId` (bytes32, XRPL tx hash), `proofOwner` (EVM address).
- Response: `blockNumber`, `blockTimestamp`, `sourceAddress` (r-address), `sourceAddressHash`, `receivingAddressHash`, `intendedReceivingAddressHash`, `spentAmount`/`receivedAmount` (drops, int256), `hasMemoData`+`firstMemoData`, `hasDestinationTag`+`destinationTag`, `status` (0=SUCCESS).
- Verify on-chain via `IFdcVerification.verifyXRPPayment(IXRPPayment.Proof)`.
- Source id for testnet: `0x74657374585250‚Ä¶` ("testXRP"). Attestation type: `0x5061796d656e74‚Ä¶` ("Payment") or XRPPayment variant.

### Redemption (settle-to-XRP flow)
- `redeemWithTag(uint256 amountUBA, string underlyingAddressString, address payable executor, uint256 destinationTag)` ‚Äî XRP-only; gated by `redeemWithTagSupported`.
- `redeemAmount(amountUBA, ...)` ‚Äî arbitrary amount UBA.

### FTSO pricing
- XRP/USD feed id: `0x015852502f55534400000000000000000000000000`. FLR/USD: `0x01464c522f555344‚Ä¶`.
- `FtsoV2.getFeedById(id)` / `getFeedByIdInWei(id)`.

### Registry (resolve all addresses at runtime)
- `FlareContractsRegistry` (all Flare networks): `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`.
- `getContractAddressByName("AssetManagerFXRP")` ‚Üí AssetManager; `.fAsset()` ‚Üí FXRP ERC-20.

## Security guardrails (skill-mandated)
- Skills are reference-only; never auto-execute txs or handle keys.
- DRY_RUN=true by default; explicit flag to broadcast.
- Treat XRPL memos + FDC responses as UNTRUSTED. Decode only via fixed binary formats. Match orders from on-chain-verified fields AFTER FDC proof confirmed.
- Never hardcode Coston2 params for mainnet ‚Äî read live from chain.

## Phase 0 ‚Äî verified live on Coston2 (read-only)
- AssetManagerFXRP: 0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA
- FXRP token: 0x0b6A3645c240605887a5532109323A3E12273dc7
- Core Vault XRPL addr: rDhpmiPq4BVBDWMVdSrmkgt8thKyRzGV1p
- Fees: minimumFee 100000 UBA, feeBIPS 25, executorFee 100000 UBA, othersCanExecuteAfter 7200s
- Hourly limit 100000000000 UBA, Daily limit 500000000000 UBA
- MintingTagManager: 0x094511737909b626391106bBc21B25feb2D67B96
- redeemWithTagSupported: true
- FTSO XRP/USD ~1.016 (6 decimals), FLR/USD ~0.0061 (8 decimals)

## FTSO gotchas (learned during Phase 0)
- On Coston2 use `registry.getTestFtsoV2()` (free view, no fees), NOT `getContractAddressByName("FtsoV2")` (reverts on getFeedById).
- `getFeedById(bytes21)` returns `(uint256 value, int8 decimals, uint64 timestamp)` ‚Äî 3 flat values, NOT a struct tuple. Selector is `0x93e9f806`.
- Feed IDs: XRP/USD `0x015852502f555344‚Ä¶`, FLR/USD `0x01464c522f555344‚Ä¶`.

## XRPL watcher gotcha
- `account_tx` responses have `tx.Amount` undefined; the delivered amount is in `meta.delivered_amount` (string for XRP, in drops).

## Project layout
- `src/memo/encoder.ts` ‚Äî 32B/48B/0xFE/0xFF memo encode+decode (37 round-trip tests pass)
- `src/chain/registry.ts` ‚Äî FlareContractsRegistry address resolver
- `src/chain/asset-manager.ts` ‚Äî read-only AssetManager (mint fees, redemption fees, Core Vault, tag manager)
- `src/chain/ftso.ts` ‚Äî FTSO XRP/USD + FLR/USD feeds
- `src/chain/fdc.ts` ‚Äî FDC XRPPayment attestation client (prepare + getProof)
- `src/chain/xrpl-watcher.ts` ‚Äî Core Vault payment monitor
- `src/checkout/order.ts` ‚Äî Order model, USD‚ÜíXRP quote math, state machine (Flow A + Flow B states)
- `src/checkout/matcher.ts` ‚Äî match XRPL vault payment ‚Üí open order by tag/amount/expiry (pure, security-critical first filter)
- `src/checkout/pricing.ts` ‚Äî fee-stack accounting: mint fee (bips + floor + executor), redeem fee (bips), operator fee; Flow A vs Flow B breakdown
- `src/checkout/refund.ts` ‚Äî refund/retry policy: OVERPAID‚ÜíCREDIT, UNDERPAID‚ÜíREJECT, REDEEM_DEFAULT‚ÜíRETRY/REFUND; refund amount = customer - sunk mint fee
- `src/checkout/redeemer.ts` ‚Äî approve FXRP ‚Üí redeemWithTag ‚Üí parse RedemptionWithTagRequested(requestId); DRY_RUN by default
- `src/checkout/webhook.ts` ‚Äî HMAC-signed merchant webhooks (sign + verify + deliver) with Flow B settlement fields
- `src/checkout/tag-pool.ts` ‚Äî MintingTagManager tag allocation/rotation pool
- `src/checkout/order-store.ts` ‚Äî in-memory order store (id + tag index)
- `src/checkout/executor.ts` ‚Äî executor relayer: FDC proof ‚Üí executeDirectMinting (DRY_RUN by default)
- `src/checkout/checkout-service.ts` ‚Äî orchestrator: create+price order, poll+match, settle (Flow A: mint‚ÜíSETTLED; Flow B: mint‚ÜíMINTED‚Üíredeem‚ÜíREDEEMED), default‚Üíretry/refund, expire, webhook
- `src/api/server.ts` ‚Äî minimal node:http API (no framework): /orders, /healthz, /admin/poll
- `src/scripts/check-params.ts` ‚Äî live Coston2 validation (5 steps: registry, mint fees, redeem fees, FTSO, XRPL)
- `src/scripts/run-checkout.ts` ‚Äî Phase 1 demo (Flow A, DRY_RUN)
- `src/scripts/run-checkout-b.ts` ‚Äî Phase 2 demo (Flow B pricing + orchestration, DRY_RUN)
- Run: `npm test` (vitest, 128 tests), `npm run check:params` (live Coston2), `npm run checkout` (Flow A demo), `npm run checkout:b` (Flow B demo)

## Phase 2 ‚Äî done (Flow B: settle-to-XRP via redeemWithTag, dry-run validated)
- **Pricing hardening**: `pricing.ts` computes the full fee stack ‚Äî mint fee (BIPS %, floored at minimum, + executor fee with insufficiency reduction), redemption fee (CoreVaultRedemptionFeeBIPS), operator service fee. Flow A: merchant gets FXRP = customer ‚àí mint fee. Flow B: merchant gets XRP = FXRP ‚àí redeem fee ‚àí operator fee. `merchantProtected` flag rejects quotes where fees consume everything. Live Coston2 params: redemptionFeeBIPS=0, minRedeemAmountUBA=5M drops, minRedeemLots=10.
- **State machine**: Flow B path SETTLING‚ÜíMINTED‚ÜíREDEEMING‚ÜíREDEEMED, plus REDEEM_DEFAULTED‚ÜíREDEEMING (retry) / REFUNDED / FAILED. 11 new transition rules tested.
- **Redeemer**: `redeemWithTag(amountUBA, xrplAddress, executor, tag)` ‚Äî validates `redeemWithTagSupported` + `minimumRedeemAmountUBA` + uint32 tag; approve FXRP ‚Üí redeem ‚Üí parse `RedemptionWithTagRequested` event for requestId; DRY_RUN by default.
- **Refund policy**: `decideRefundPolicy` ‚Äî OVERPAID‚ÜíCREDIT, UNDERPAID‚ÜíREJECT (customer recovers via Core Vault), REDEEM_DEFAULTED‚ÜíRETRY (attempts<max) or REFUND (attempts exhausted). `computeRefundAmount` = customer payment ‚àí sunk mint fee (operator waives its fee on refund).
- **Service orchestration**: `settleOrder` dispatches Flow A (mint‚ÜíSETTLED) or Flow B (mint‚ÜíMINTED‚Üíredeem‚ÜíREDEEMED). `handleRedemptionDefault` + `applyRetryOrRefund` + `refundOrder` implement the retry/refund loop. Webhook payload extended with settlementMode, merchantXrpDrops, redemptionRequestId, full feeBreakdown.
- **Limitations**: FDC round discovery still stubbed (Phase 1 carryover). `confirmXRPRedemptionPayment` / `redemptionPaymentDefault(proof, requestId)` are wired in the redeemer/service but not exercised live (needs funded wallets + a real agent default). Refund is a stub (no XRPL Payment broadcast). REDEEMED is marked optimistically once redeemWithTag is accepted; agent-payout confirmation polling deferred.

## Phase 3 ‚Äî FDC live integration (DONE, e2e mint verified on Coston2)

### FDC proof pipeline (verified live)
- **FdcHubClient** (`src/chain/fdc-hub.ts`): `requestAttestation(abiEncodedRequest)` submits on-chain; fee via `FeeConfigurations.getRequestFee`; round id from `FlareSystemsManager.firstVotingRoundIdStartingAtTimestamp(blockTimestamp)`. Cost: ~1000 wei on Coston2.
- **Proof fetch**: DA layer endpoint `api/v1/fdc/proof-by-request-round-raw` (POST `{votingRoundId, requestBytes}`). Returns `{proof: string[], response_hex: string}`. The DA layer API can lag 30-60s behind on-chain Relay finalization ‚Äî retry with backoff.
- **Protocol ID**: FdcVerification.fdcProtocolId() = **200** (NOT 0). Relay.merkleRoots(200, round) has the populated root; merkleRoots(0, round) is empty. Always use protocol ID 200 for XRP payment verification.
- **Response decoding**: response_hex (896 bytes) is `abi.encode(Response)` ‚Äî starts with a 0x0020 outer offset. Decodes cleanly as the IXRPPayment.Response struct via the canonical 16-field ABI.

### calldata encoding for executeDirectMinting (the critical fix)
- `executeDirectMinting(Proof)` takes a **single dynamic-tuple arg** ‚Üí outer encoding = `[offset_to_Proof=0x20] + Proof_encoding`.
- Inside `Proof = (bytes32[] merkleProof, Response data)`: `[offset_merkle=0x40, offset_data] + merkleProof_enc + response_enc`.
- **Both** `coder.encode(["bytes32[]"], [...])` and `response_hex` (= `abi.encode(Response)`) wrap their payload in a 32-byte outer offset envelope ([0x0020]+data). Inside the Proof tuple the head already provides the offset, so **strip the leading 32 bytes (64 hex chars after "0x") from each** before concatenating.
- Fixed `encodeProofCalldata` in `src/checkout/executor.ts` ‚Äî output now byte-identical to ethers AbiCoder. Verified: `eth_call` returns `PaymentAlreadyConfirmed` (0x18dce79f), proving the contract decodes the proof correctly.

### Error 0x18dce79f = PaymentAlreadyConfirmed()
- Selector `0x18dce79f` = `PaymentAlreadyConfirmed()` (found by cloning flare-foundation/fassets and matching all 315 error selectors). It is thrown when `verifiedPayments[transactionId] != 0`.
- **An executor bot races to mint finalized attestations** (anyone can call executeDirectMinting and earn the executor fee). If you see PaymentAlreadyConfirmed, the mint already happened ‚Äî the merchant still receives FXRP, just minted by someone else. Treat as success.
- Other direct-minting errors (all in DirectMintingFacet.sol): InvalidExecutor, InvalidReceivingAddress, AmountNotPositive, PaymentIsCoreVaultDonation, ForbiddenPaymentReference, DirectMintingStillDelayed, MissingMintingTagManager, MissingSmartAccountManager, DirectMintingNotUnblocked, NoValueExpected, NoDataExpectedForDirectMinting.

### E2E live mint result (Coston2, verified)
- XRPL Payment 1 XRP ‚Üí Core Vault with 32B direct-minting memo ‚Üí FDC attestation (round 1422077) ‚Üí Merkle proof ‚Üí executeDirectMinting.
- Merchant received **0.8 FTestXRP** (800,000 UBA) net: 1,000,000 received ‚àí 100,000 minting fee (minimumFeeUBA floored) ‚àí 100,000 executor fee.
- Fee structure: `mintingFee = max(minimumFeeUBA, receivedAmount * feeBIPS / 10000)`; for 1 XRP the floor (100,000) dominates over the bips amount (2,500).

## Frontend (React + Vite + wagmi + viem)

### Stack
- **React 19 + Vite 5 + TypeScript** ‚Äî SPA in `/workspace/project/frontend/`
- **wagmi + viem** ‚Äî wallet connection, on-chain reads (FXRP ERC-20 balance)
- **@tanstack/react-query** ‚Äî order polling (auto-stops at terminal status)
- **react-router-dom** ‚Äî routes: `/` (merchant dashboard), `/checkout` (new order), `/checkout/:orderId` (order detail)
- **qrcode.react** ‚Äî XRPL payment QR code on the checkout page
- **@flarenetwork/flare-wagmi-periphery-package** ‚Äî Coston2 chain config + injected connector
- Vite dev proxy: `/api` ‚Üí `http://localhost:3000` (backend API)

### Pages
- **MerchantDashboard** (`src/pages/MerchantDashboard.tsx`): 2-column layout. Left sidebar: wallet info (FXRP on-chain balance when connected), create-order form, API health. Right column: analytics stat cards (total/settled/pending/FXRP), volume bar chart (last 10 orders), orders table with filter pills (all/pending/settled/expired), live status, created date, settle/refund tx links. Uses `listAll()` (all orders, not just open).
- **CheckoutPage** (`src/pages/CheckoutPage.tsx`): order creation form → Shopify-style order detail with: order ID prominent, status badge + countdown, progress bar (Awaiting→Detected→Minting→Minted), amount summary card, **FXRP recipient card** (shows connected Flare wallet or merchant fallback — the address encoded in the direct-minting memo), **fee breakdown visible before payment** (customer sends, mint fee, service fee, merchant receives), **one-click Crossmark pay** (builds direct-minting Payment with 0x4642505266410018 memo, signs+submits via `sdk.async.signAndSubmitAndWait`), QR + deep-link fallback, payment JSON toggle, terminal states (settled/refunded/expired/failed) with icons. Route `/checkout/:orderId` references a specific order.

### Wallet connection (shared state)
- **XrpWalletProvider** (`src/components/XrpWalletProvider.tsx`): React context wrapping the app in `main.tsx`. Shares XRP wallet state between WalletBar (nav) and CheckoutPage (payment shortcut) so they stay in sync. State persisted to localStorage.
- **useXrpWallet** (`src/hooks/useXrpWallet.ts`): Crossmark SDK integration (`window.crossmark`). Uses `sdk.async.signInAndWait()` for connection, `sdk.async.signAndSubmitAndWait(tx)` for one-click payment signing. Falls back to manual address entry (read-only, no signing). Exposes `signAndSubmitPayment(tx)` ‚Üí returns `{ hash }`. Network label tracked.
- **WalletBar** (`src/components/WalletBar.tsx`): dual connection ‚Äî Flare (wagmi/injected) + XRP (Crossmark/manual). Shows truncated address + network + disconnect. Install Crossmark link when extension not detected.

### Direct-minting memo encoding (`src/xrpl.ts`)
- `buildDirectMintingMemo(recipient)` ‚Üí 32-byte hex: `4642505266410018` (8B prefix) + `00000000` (4B zeros) + 20B recipient Flare address (lowercase, no 0x). Signals DIRECT_MINTING to AssetManager.
- `buildDirectMintingPayment({destination, xrpAmountDrops, recipientFlareAddress, destinationTag?})` ‚Üí raw XRPL Payment tx object with the memo. Crossmark handles autofill.
- Smart-account opcodes (0xFE hash-commit, 0xFF inline userOp) documented but not yet wired into checkout ‚Äî for future atomic mint+action flows.

### Build / dev
- `cd frontend && npm install` ‚Üí install deps
- `npm run dev` ‚Üí vite dev server on :5173 (proxies `/api` to :3000)
- `npm run build` ‚Üí production bundle in `frontend/dist/`
- `npx tsc --noEmit` ‚Üí type check (currently clean)
- Frontend build verified: 4700 modules transformed, ~404 kB JS (124 kB gzip)
- New dep: `@crossmarkio/sdk` (Crossmark wallet integration — used via injected `window.crossmark`, no direct import needed)

### Backend CORS
- `src/api/server.ts` now sends `Access-Control-Allow-Origin: *` + handles `OPTIONS` preflight, so the frontend can call the API directly or through the Vite proxy.

### Key files
- `src/types.ts` ‚Äî shared Order, Quote, FeeBreakdown types + status helpers (statusS tepIndex, FLOW_STEPS, isTerminal, dropsToXrp)
- `src/api.ts` ‚Äî type-safe API client (createOrder, getOrder, listOrders, pollOnce, expire, healthz)
- `src/wagmi.ts` ‚Äî wagmi config (Coston2 chain, injected connector, FXRP token address)
- `src/xrpl.ts` ‚Äî XRPL payment URI builder + payment JSON generator (Core Vault address, memo hex encoding)
- `src/components/` ‚Äî CopyField, StatusBadge, StatusFlow, CountdownTimer
- `src/hooks/useOrderPoll.ts` ‚Äî react-query hook that polls every 3s, stops at terminal status

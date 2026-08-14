import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { useAccount } from "wagmi";
import { api } from "../api";
import { useOrderPoll } from "../hooks/useOrderPoll";
import { useXrpWalletContext } from "../components/XrpWalletProvider";
import {
  TESTNET_CORE_VAULT,
  buildXrplPaymentUri,
  buildXrplPaymentJson,
  buildDirectMintingMemo,
  buildDirectMintingPayment,
} from "../xrpl";
import { CopyField } from "../components/CopyField";
import { StatusFlow, StatusBadge } from "../components/StatusBadge";
import { CountdownTimer } from "../components/CountdownTimer";
import { dropsToXrp, isTerminal, type Order } from "../types";

export default function CheckoutPage() {
  const { orderId } = useParams<{ orderId?: string }>();
  const navigate = useNavigate();
  const [usdAmount, setUsdAmount] = useState("");

  const createMutation = useMutation({
    mutationFn: (amt: number) => api.createOrder({ usdAmount: amt }),
    onSuccess: (order) => {
      navigate(`/checkout/${order.id}`);
    },
  });

  const poll = useOrderPoll(orderId);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(usdAmount);
    if (isNaN(amt) || amt <= 0) return;
    createMutation.mutate(amt);
  };

  // --- No order yet: show the order creation form ---
  if (!orderId || !poll.data) {
    return (
      <div className="checkout-layout">
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <h1 style={{ fontSize: 26, fontWeight: 800, marginBottom: 6 }}>FXRP Checkout</h1>
          <p className="dim" style={{ fontSize: 15 }}>
            Pay with XRP on XRPL. Receive FXRP on Flare. Gasless — you never need FLR.
          </p>
        </div>
        <form onSubmit={handleCreate} className="card col" style={{ gap: 16 }}>
          <div>
            <label className="label">Amount (USD)</label>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)", fontWeight: 700, fontSize: 18 }}>$</span>
              <input
                className="input"
                type="number"
                step="0.01"
                min="0.01"
                placeholder="10.00"
                value={usdAmount}
                onChange={(e) => setUsdAmount(e.target.value)}
                disabled={createMutation.isPending}
                style={{ paddingLeft: 30, fontSize: 18, fontWeight: 600 }}
              />
            </div>
          </div>
          {createMutation.isError && (
            <div style={{ color: "var(--danger)", fontSize: 14 }}>
              {(createMutation.error as Error).message}
            </div>
          )}
          <button type="submit" className="btn btn-primary" disabled={createMutation.isPending || !usdAmount} style={{ justifyContent: "center", padding: "14px 20px", fontSize: 16 }}>
            {createMutation.isPending ? "Creating…" : "Create Checkout →"}
          </button>
        </form>
      </div>
    );
  }

  // --- Order exists: show payment details + live status ---
  return <OrderDetail order={poll.data} isLoading={poll.isLoading} />;
}

function OrderDetail({ order, isLoading }: { order: Order; isLoading: boolean }) {
  const terminal = isTerminal(order.status);
  const xrpAmount = dropsToXrp(order.quote.xrpAmountDrops);
  const vaultAddr = TESTNET_CORE_VAULT;
  const { address: flareAddress, isConnected: flareConnected } = useAccount();

  // The FXRP recipient is the customer's connected Flare wallet, or the order's
  // merchant address as fallback. This address is encoded in the direct-minting memo.
  const recipientFlareAddress = flareConnected && flareAddress
    ? flareAddress
    : order.merchantFlareAddress;

  const memoHex = buildDirectMintingMemo(recipientFlareAddress);
  const paymentUri = buildXrplPaymentUri({
    destination: vaultAddr,
    amountDrops: order.quote.xrpAmountDrops,
    memoHex,
  });

  const showPayment = order.status === "AWAITING_PAYMENT" || order.status === "CREATED";

  return (
    <div style={{ maxWidth: 600, margin: "0 auto" }} className="col">
      {/* Order header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <div>
          <div className="dim" style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
            Order
          </div>
          <h1 className="mono" style={{ fontSize: 20, fontWeight: 700 }}>{order.id}</h1>
        </div>
        <div style={{ textAlign: "right" }}>
          <StatusBadge status={order.status} />
          {!terminal && (
            <div className="dim" style={{ fontSize: 13, marginTop: 6 }}>
              Expires in <CountdownTimer expiresAt={order.quote.expiresAt} />
            </div>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="card" style={{ padding: 16 }}>
        <StatusFlow status={order.status} />
      </div>

      {/* Amount summary */}
      <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 24px" }}>
        <div>
          <div className="label" style={{ marginBottom: 2 }}>Total Due</div>
          <div style={{ fontSize: 28, fontWeight: 800 }}>${order.quote.usdAmount.toFixed(2)}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="label" style={{ marginBottom: 2 }}>Pay in XRP</div>
          <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: "var(--accent)" }}>
            {xrpAmount} XRP
          </div>
        </div>
      </div>

      {/* FXRP recipient info — shows where FXRP will be minted */}
      <div className="card" style={{ padding: "16px 24px" }}>
        <div className="label" style={{ marginBottom: 8 }}>FXRP Recipient (Flare)</div>
        {flareConnected && flareAddress ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="badge badge-success">Your wallet</span>
            <span className="mono" style={{ fontSize: 14, wordBreak: "break-all" }}>
              {flareAddress}
            </span>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <span className="mono dim" style={{ fontSize: 14, wordBreak: "break-all" }}>
              {order.merchantFlareAddress}
            </span>
            <span className="dim" style={{ fontSize: 13 }}>
              Connect Flare wallet to receive FXRP to your own address →
            </span>
          </div>
        )}
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          This address is encoded in the direct-minting memo. FXRP will be minted here when the executor finalizes.
        </div>
      </div>

      {/* Fee transparency — always visible */}
      {order.feeBreakdown && <FeeSummary order={order} />}

      {showPayment ? (
        <PaymentSection
          vaultAddr={vaultAddr}
          xrpAmount={xrpAmount}
          amountDrops={order.quote.xrpAmountDrops}
          memoHex={memoHex}
          paymentUri={paymentUri}
          destinationTag={order.tagId}
          recipientFlareAddress={recipientFlareAddress}
        />
      ) : terminal ? (
        <TerminalSection order={order} />
      ) : (
        <SettlementSection order={order} isLoading={isLoading} />
      )}

      {order.error && (
        <div className="card" style={{ borderColor: "var(--danger)", background: "var(--danger-light)" }}>
          <div className="label" style={{ color: "var(--danger)" }}>Error</div>
          <div style={{ fontSize: 14 }}>{order.error}</div>
        </div>
      )}
    </div>
  );
}

/** Fee transparency — shown before payment so the customer knows the breakdown. */
function FeeSummary({ order }: { order: Order }) {
  const fb = order.feeBreakdown!;
  return (
    <div className="card" style={{ padding: "16px 24px" }}>
      <div className="label" style={{ marginBottom: 10 }}>Fee Breakdown</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
        <FeeRow label="Customer sends" value={`${dropsToXrp(fb.customerXrpDrops)} XRP`} />
        <FeeRow label="Mint fee (FAssets)" value={`−${dropsToXrp(fb.mintFeeDrops)} XRP`} muted />
        {fb.operatorFeeDrops !== "0" && (
          <FeeRow label="Service fee" value={`−${dropsToXrp(fb.operatorFeeDrops)} XRP`} muted />
        )}
        {fb.redeemFeeDrops !== "0" && (
          <FeeRow label="Redeem fee" value={`−${dropsToXrp(fb.redeemFeeDrops)} XRP`} muted />
        )}
        <div style={{ borderTop: "1px solid var(--border)", marginTop: 4, paddingTop: 8, display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 700 }}>Merchant receives</span>
          <span className="mono" style={{ fontWeight: 700, color: "var(--success)" }}>
            {dropsToXrp(fb.merchantFxrpDrops)} FXRP
          </span>
        </div>
      </div>
    </div>
  );
}

function FeeRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span className={muted ? "dim" : ""}>{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

function PaymentSection({
  vaultAddr,
  xrpAmount,
  amountDrops,
  memoHex,
  paymentUri,
  destinationTag,
  recipientFlareAddress,
}: {
  vaultAddr: string;
  xrpAmount: string;
  amountDrops: string;
  memoHex: string | undefined;
  paymentUri: string;
  destinationTag?: number;
  recipientFlareAddress: string;
}) {
  const [showJson, setShowJson] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [payTxHash, setPayTxHash] = useState<string | null>(null);
  const xrp = useXrpWalletContext();

  const paymentJson = buildXrplPaymentJson({
    destination: vaultAddr,
    amountDrops,
    memoHex,
    destinationTag,
  });

  /** One-click pay: build the direct-minting Payment and sign+submit via Crossmark. */
  const handlePayWithCrossmark = async () => {
    setPaying(true);
    setPayError(null);
    try {
      const tx = buildDirectMintingPayment({
        destination: vaultAddr,
        xrpAmountDrops: amountDrops,
        recipientFlareAddress,
        destinationTag,
      });
      const result = await xrp.signAndSubmitPayment(tx);
      setPayTxHash(result.hash);
    } catch (e) {
      setPayError((e as Error).message);
    } finally {
      setPaying(false);
    }
  };

  // Determine which payment path to highlight
  const canPayWithCrossmark = xrp.connected && xrp.hasExtension;
  const showCrossmarkSuccess = payTxHash !== null;

  return (
    <div className="card" style={{ padding: 24 }}>
      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <div className="success-icon" style={{ background: "var(--accent-light)", color: "var(--accent)", width: 56, height: 56, fontSize: 28 }}>◎</div>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Send XRP Payment</h2>
        <p className="dim" style={{ fontSize: 14 }}>
          Send exactly <strong style={{ color: "var(--accent)" }}>{xrpAmount} XRP</strong> to the Core Vault
          with the direct-minting memo below.
        </p>
      </div>

      {/* === Primary path: Pay with Crossmark === */}
      {canPayWithCrossmark && !showCrossmarkSuccess && (
        <div style={{ marginBottom: 20, padding: 16, background: "var(--accent-light)", borderRadius: "var(--radius)", border: "1px solid var(--accent-soft)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span className="badge badge-success">Crossmark Connected</span>
            <span className="mono dim" style={{ fontSize: 13 }}>{xrp.address!.slice(0, 8)}…{xrp.address!.slice(-4)}</span>
            {xrp.network && <span className="dim" style={{ fontSize: 11 }}>· {xrp.network}</span>}
          </div>
          <p className="dim" style={{ fontSize: 13, marginBottom: 12 }}>
            This will open Crossmark to sign and submit an XRPL Payment of <strong>{xrpAmount} XRP</strong> to the
            Flare Core Vault. The direct-minting memo encodes the recipient <code className="mono" style={{ fontSize: 12 }}>{recipientFlareAddress.slice(0, 8)}…{recipientFlareAddress.slice(-4)}</code> so FXRP is minted to that address.
          </p>
          <button
            className="btn btn-primary"
            onClick={handlePayWithCrossmark}
            disabled={paying}
            style={{ width: "100%", justifyContent: "center", padding: "12px 20px", fontSize: 15 }}
          >
            {paying ? (
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="spinner" /> Waiting for signature…
              </span>
            ) : (
              `Pay ${xrpAmount} XRP via Crossmark →`
            )}
          </button>
          {payError && (
            <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 10, textAlign: "center" }}>
              {payError}
            </div>
          )}
        </div>
      )}

      {/* === Crossmark success confirmation === */}
      {showCrossmarkSuccess && (
        <div className="card" style={{ marginBottom: 20, padding: 16, background: "var(--success-light)", border: "1px solid var(--success)", textAlign: "center" }}>
          <div className="success-icon" style={{ margin: "0 auto 8px" }}>✓</div>
          <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Payment Submitted!</h3>
          <p className="dim" style={{ fontSize: 13, marginBottom: 12 }}>
            XRPL tx hash:
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center" }}>
            <code className="mono" style={{ fontSize: 13 }}>{payTxHash!.slice(0, 16)}…</code>
            <button className="copy-btn" onClick={() => navigator.clipboard.writeText(payTxHash!)} type="button">Copy</button>
          </div>
          <a
            href={`https://testnet.xrpl.org/transactions/${payTxHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-sm"
            style={{ marginTop: 12, justifyContent: "center" }}
          >
            View on XRPL Explorer →
          </a>
          <p className="dim" style={{ fontSize: 13, marginTop: 12 }}>
            The executor will detect this payment and mint FXRP on Flare automatically.
          </p>
        </div>
      )}

      {/* === Manual path: QR + deep-link === */}
      {!showCrossmarkSuccess && (
        <>
          <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
            {/* QR code */}
            <div style={{ textAlign: "center" }}>
              <div className="qr-container">
                <QRCodeSVG
                  value={paymentUri}
                  size={172}
                  level="M"
                />
              </div>
              <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>Scan with XRPL wallet</div>
            </div>

            {/* Payment details */}
            <div className="col" style={{ flex: 1, minWidth: 220, gap: 10 }}>
              <CopyField label="Core Vault (XRPL)" value={vaultAddr} />
              {destinationTag !== undefined && (
                <CopyField label="Destination Tag" value={destinationTag.toString()} truncate={false} />
              )}
              <CopyField label="Amount" value={`${xrpAmount} XRP`} truncate={false} mono={false} />
              {memoHex && <CopyField label="Memo (direct-mint hex)" value={memoHex} />}
            </div>
          </div>

          {/* Actions */}
          <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <a href={paymentUri} target="_blank" rel="noopener noreferrer" className="btn btn-sm" style={{ flex: 1, justifyContent: "center" }}>
              Open in XRPL Wallet →
            </a>
            <button className="btn btn-sm" onClick={() => setShowJson(!showJson)} type="button" style={{ flex: 1, justifyContent: "center" }}>
              {showJson ? "Hide" : "Show"} Payment JSON
            </button>
          </div>
        </>
      )}

      {showJson && !showCrossmarkSuccess && (
        <pre
          className="mono"
          style={{
            fontSize: 12,
            background: "var(--bg-subtle)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            padding: 12,
            overflow: "auto",
            color: "var(--text-dim)",
            marginTop: 12,
          }}
        >
          {JSON.stringify(paymentJson, null, 2)}
        </pre>
      )}

      <div
        style={{
          marginTop: 16,
          padding: 12,
          background: "var(--warning-light)",
          borderRadius: "var(--radius-sm)",
          fontSize: 13,
          color: "var(--warning)",
          display: "flex",
          gap: 8,
          alignItems: "flex-start",
        }}
      >
        <span>⚠</span>
        <span>Send exactly the specified amount. The memo encodes the recipient Flare address — without it, the payment cannot be matched to your order.</span>
      </div>
    </div>
  );
}

function SettlementSection({ order, isLoading }: { order: Order; isLoading: boolean }) {
  return (
    <div className="card" style={{ padding: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <div className="spinner" />
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>Settlement in Progress</h2>
      </div>
      <p className="dim" style={{ fontSize: 14, marginBottom: 16 }}>
        {isLoading ? "Checking for payment…" : "Payment detected. Minting FXRP on Flare via FDC proof…"}
      </p>

      {order.matchedTxHash && (
        <div style={{ marginBottom: 12 }}>
          <CopyField label="XRPL Payment Tx" value={order.matchedTxHash} />
        </div>
      )}
      {order.settleTxHash && (
        <div>
          <div className="label">Flare Mint Tx</div>
          <a
            href={`https://coston2-explorer.flare.network/tx/${order.settleTxHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mono"
            style={{ fontSize: 14 }}
          >
            {order.settleTxHash.slice(0, 12)}…{order.settleTxHash.slice(-8)} →
          </a>
        </div>
      )}
    </div>
  );
}

function TerminalSection({ order }: { order: Order }) {
  const isSettled = order.status === "SETTLED" || order.status === "REDEEMED";
  const isRefunded = order.status === "REFUNDED";
  const isError = order.status === "EXPIRED" || order.status === "FAILED";

  return (
    <div className="card" style={{ padding: 24, textAlign: "center" }}>
      {isSettled ? (
        <>
          <div className="success-icon">✓</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>Payment Successful</h2>
          <p className="dim" style={{ marginBottom: 16 }}>
            FXRP has been minted to the merchant on Flare.
          </p>
        </>
      ) : isRefunded ? (
        <>
          <div className="success-icon" style={{ background: "var(--info-light)", color: "var(--info)" }}>↩</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>Refunded</h2>
          <p className="dim" style={{ marginBottom: 16 }}>
            Your XRP has been refunded. See details below.
          </p>
        </>
      ) : isError ? (
        <>
          <div className="success-icon" style={{ background: "var(--danger-light)", color: "var(--danger)" }}>✕</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>
            {order.status === "EXPIRED" ? "Order Expired" : "Order Failed"}
          </h2>
          <p className="dim" style={{ marginBottom: 16 }}>
            {order.status === "EXPIRED"
              ? "The payment window has closed. Create a new order to try again."
              : "Something went wrong during settlement. Please contact support."}
          </p>
        </>
      ) : null}

      {/* Settlement details */}
      {order.settleTxHash && (
        <div style={{ marginBottom: 12 }}>
          <CopyField label="Flare Mint Tx" value={order.settleTxHash} />
        </div>
      )}
      {order.refundTxHash && (
        <div style={{ marginBottom: 12 }}>
          <CopyField label="Refund XRPL Tx" value={order.refundTxHash} />
        </div>
      )}
    </div>
  );
}

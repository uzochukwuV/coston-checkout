import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { api } from "../api";
import { useOrderPoll } from "../hooks/useOrderPoll";
import { TESTNET_CORE_VAULT, buildXrplPaymentUri, buildXrplPaymentJson } from "../xrpl";
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
      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>Checkout</h1>
        <p className="dim" style={{ marginBottom: 32 }}>
          Pay with XRP on XRPL. Receive FXRP on Flare. Gasless — you never need FLR.
        </p>
        <form onSubmit={handleCreate} className="card col">
          <div>
            <label className="label">Amount (USD)</label>
            <input
              className="input"
              type="number"
              step="0.01"
              min="0.01"
              placeholder="10.00"
              value={usdAmount}
              onChange={(e) => setUsdAmount(e.target.value)}
              disabled={createMutation.isPending}
            />
          </div>
          {createMutation.isError && (
            <div style={{ color: "var(--danger)", fontSize: 14 }}>
              {(createMutation.error as Error).message}
            </div>
          )}
          <button type="submit" className="btn btn-primary" disabled={createMutation.isPending || !usdAmount}>
            {createMutation.isPending ? "Creating…" : "Create Order"}
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
  const memoHex = buildMemoHex(order);
  const paymentUri = buildXrplPaymentUri({
    destination: vaultAddr,
    amountDrops: order.quote.xrpAmountDrops,
    memoHex,
  });

  // Show payment instructions when waiting for payment
  const showPayment = order.status === "AWAITING_PAYMENT" || order.status === "CREATED";

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }} className="col">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>
            Order {order.id.slice(0, 8)}
          </h1>
          <div className="dim" style={{ fontSize: 14 }}>
            Pay {xrpAmount} XRP → receive FXRP on Flare
          </div>
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

      <div className="card col">
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Settlement Progress</h2>
        <StatusFlow status={order.status} />
      </div>

      {showPayment ? (
        <PaymentSection
          vaultAddr={vaultAddr}
          xrpAmount={xrpAmount}
          amountDrops={order.quote.xrpAmountDrops}
          memoHex={memoHex}
          paymentUri={paymentUri}
          destinationTag={order.tagId}
        />
      ) : (
        <SettlementSection order={order} isLoading={isLoading} />
      )}

      {order.error && (
        <div className="card" style={{ borderColor: "var(--danger)", background: "rgba(248,113,113,0.06)" }}>
          <div className="label" style={{ color: "var(--danger)" }}>Error</div>
          <div style={{ fontSize: 14 }}>{order.error}</div>
        </div>
      )}
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
}: {
  vaultAddr: string;
  xrpAmount: string;
  amountDrops: string;
  memoHex: string | undefined;
  paymentUri: string;
  destinationTag?: number;
}) {
  const [showJson, setShowJson] = useState(false);
  const paymentJson = buildXrplPaymentJson({
    destination: vaultAddr,
    amountDrops,
    memoHex,
    destinationTag,
  });

  return (
    <div className="card col">
      <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Send XRP Payment</h2>
      <p className="dim" style={{ fontSize: 14, marginBottom: 16 }}>
        Send exactly <strong style={{ color: "var(--accent)" }}>{xrpAmount} XRP</strong> to the Core Vault
        address below. Include the memo so the payment can be matched to your order.
      </p>

      <div style={{ display: "flex", gap: 32, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "0 0 auto", textAlign: "center" }}>
          <div
            style={{
              background: "white",
              padding: 16,
              borderRadius: "var(--radius-sm)",
              display: "inline-block",
            }}
          >
            <QRCodeSVG
              value={paymentUri}
              size={180}
              level="M"
              includeMargin
            />
          </div>
          <div className="dim" style={{ fontSize: 12, marginTop: 8, maxWidth: 180 }}>
            Scan with an XRPL wallet
          </div>
        </div>

        <div className="col" style={{ flex: 1, minWidth: 240 }}>
          <CopyField label="Core Vault (XRPL)" value={vaultAddr} />
          {destinationTag !== undefined && (
            <CopyField label="Destination Tag" value={destinationTag.toString()} truncate={false} />
          )}
          <CopyField label="Amount" value={`${xrpAmount} XRP`} truncate={false} mono={false} />
          {memoHex && <CopyField label="Memo (hex)" value={memoHex} />}
        </div>
      </div>

      <div style={{ marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <a href={paymentUri} target="_blank" rel="noopener noreferrer" className="btn btn-sm">
          Open in XRPL wallet →
        </a>
        <button className="btn btn-sm" onClick={() => setShowJson(!showJson)} type="button">
          {showJson ? "Hide" : "Show"} raw payment JSON
        </button>
      </div>

      {showJson && (
        <pre
          className="mono"
          style={{
            fontSize: 12,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            padding: 12,
            overflow: "auto",
            color: "var(--text-dim)",
          }}
        >
          {JSON.stringify(paymentJson, null, 2)}
        </pre>
      )}

      <div
        style={{
          marginTop: 8,
          padding: 12,
          background: "rgba(251,191,36,0.06)",
          border: "1px solid rgba(251,191,36,0.2)",
          borderRadius: "var(--radius-sm)",
          fontSize: 13,
          color: "var(--warning)",
        }}
      >
        ⚠ Send exactly the specified amount. The memo is required — without it, the
        payment cannot be matched to your order.
      </div>
    </div>
  );
}

function SettlementSection({ order, isLoading }: { order: Order; isLoading: boolean }) {
  return (
    <div className="card col">
      <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Settlement</h2>
      <p className="dim" style={{ fontSize: 14 }}>
        {isLoading ? "Checking for payment…" : "Payment detected. Minting FXRP on Flare…"}
      </p>

      {order.matchedTxHash && (
        <CopyField label="XRPL Payment Tx" value={order.matchedTxHash} />
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

      {order.feeBreakdown && (
        <div style={{ marginTop: 8 }}>
          <div className="label">Fee Breakdown</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 14 }}>
            <span className="dim">Customer pays</span>
            <span className="mono">{dropsToXrp(order.feeBreakdown.customerXrpDrops)} XRP</span>
            <span className="dim">Mint fee</span>
            <span className="mono">{dropsToXrp(order.feeBreakdown.mintFeeDrops)} XRP</span>
            <span className="dim">FXRP minted</span>
            <span className="mono">{dropsToXrp(order.feeBreakdown.fxrpMintedDrops)} FXRP</span>
            {order.feeBreakdown.merchantFxrpDrops !== "0" && (
              <>
                <span className="dim">Merchant receives</span>
                <span className="mono" style={{ color: "var(--success)" }}>
                  {dropsToXrp(order.feeBreakdown.merchantFxrpDrops)} FXRP
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Build the direct-minting memo hex for a Flow A order.
 * Format: 0x4642505266410018 + 00000000 + 20-byte merchant address (no 0x).
 */
function buildMemoHex(order: Order): string | undefined {
  // The backend encodes the memo; for the checkout UI we construct it from the
  // merchant's Flare address. 32-byte format: prefix(8) + zero(4) + recipient(20).
  const merchantAddr = order.merchantFlareAddress.replace(/^0x/, "").toLowerCase();
  if (merchantAddr.length !== 40) return undefined;
  return `464250526641001800000000${merchantAddr}`;
}

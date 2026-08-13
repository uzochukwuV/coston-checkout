import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useReadContract } from "wagmi";
import { erc20Abi } from "viem";
import { api } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import { dropsToXrp, isTerminal, type Order } from "../types";

/** FXRP token on Coston2 (resolved live from registry — hardcoded here for the frontend). */
const FXRP_TOKEN = "0x0b6A3645c240605887a5532109323A3E12273dc7" as const;
const COSTON2_EXPLORER = "https://coston2-explorer.flare.network";

export default function MerchantDashboard() {
  const [usdAmount, setUsdAmount] = useState("");
  const qc = useQueryClient();
  const { address, isConnected } = useAccount();

  const ordersQuery = useQuery({
    queryKey: ["orders"],
    queryFn: api.listOrders,
    refetchInterval: 5000,
  });

  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: api.healthz,
    refetchInterval: 10000,
  });

  // Read merchant's FXRP balance on-chain (optional — needs wallet connection)
  const fxrpBalance = useReadContract({
    address: FXRP_TOKEN,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address ?? "0x0"],
    query: { enabled: isConnected && !!address },
  });

  const createMutation = useMutation({
    mutationFn: (amt: number) => api.createOrder({ usdAmount: amt }),
    onSuccess: () => {
      setUsdAmount("");
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });

  const pollMutation = useMutation({
    mutationFn: api.pollOnce,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orders"] }),
  });

  const expireMutation = useMutation({
    mutationFn: api.expire,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orders"] }),
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(usdAmount);
    if (isNaN(amt) || amt <= 0) return;
    createMutation.mutate(amt);
  };

  const orders = ordersQuery.data ?? [];
  const stats = computeStats(orders);

  return (
    <div className="col" style={{ gap: 24 }}>
      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ fontSize: 28, fontWeight: 800 }}>Merchant Dashboard</h1>
        <div className="row">
          <div
            className="badge"
            style={{
              background: healthQuery.data?.ok
                ? "rgba(74,222,128,0.12)"
                : "rgba(248,113,113,0.12)",
              color: healthQuery.data?.ok ? "var(--success)" : "var(--danger)",
            }}
          >
            ● {healthQuery.data?.ok ? "API Online" : "API Offline"}
          </div>
          {isConnected && (
            <span className="dim mono" style={{ fontSize: 13 }}>
              {address?.slice(0, 6)}…{address?.slice(-4)}
            </span>
          )}
        </div>
      </div>

      {/* Stats cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
        <StatCard label="Total Orders" value={stats.total.toString()} />
        <StatCard label="Settled" value={stats.settled.toString()} accent="var(--success)" />
        <StatCard label="Pending" value={stats.pending.toString()} accent="var(--warning)" />
        <StatCard label="Total FXRP" value={`${stats.totalFxrp} FXRP`} accent="var(--accent)" />
      </div>

      {/* On-chain balance (optional, needs wallet) */}
      {isConnected && fxrpBalance.data !== undefined && (
        <div className="card-elevated" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div className="label">Your FXRP Balance (on-chain)</div>
            <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--accent)" }}>
              {dropsToXrp(fxrpBalance.data.toString())} FXRP
            </div>
          </div>
          <a
            href={`https://coston2-explorer.flare.network/address/${address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-sm"
          >
            View on Explorer →
          </a>
        </div>
      )}

      {/* Create order + actions */}
      <div className="card">
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Create Checkout Order</h2>
        <form onSubmit={handleCreate} style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 200px" }}>
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
          <div style={{ flex: "0 0 auto", display: "flex", alignItems: "flex-end" }}>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={createMutation.isPending || !usdAmount}
            >
              {createMutation.isPending ? "Creating…" : "Create Order"}
            </button>
          </div>
        </form>
        {createMutation.isError && (
          <div style={{ color: "var(--danger)", fontSize: 14, marginTop: 8 }}>
            {(createMutation.error as Error).message}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button
            className="btn btn-sm"
            onClick={() => pollMutation.mutate()}
            disabled={pollMutation.isPending}
            type="button"
          >
            {pollMutation.isPending ? "Polling…" : "Poll Now"}
          </button>
          <button
            className="btn btn-sm"
            onClick={() => expireMutation.mutate()}
            disabled={expireMutation.isPending}
            type="button"
          >
            Expire Stale
          </button>
        </div>
      </div>

      {/* Order list */}
      <div className="card">
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Orders</h2>
        {ordersQuery.isLoading ? (
          <div className="dim">Loading orders…</div>
        ) : orders.length === 0 ? (
          <div className="dim">No orders yet. Create one above to get started.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left" }}>
                  <Th>Order ID</Th>
                  <Th>USD</Th>
                  <Th>XRP</Th>
                  <Th>Status</Th>
                  <Th>Settle Tx</Th>
                  <Th>Checkout</Th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <OrderRow key={order.id} order={order} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="card-elevated">
      <div className="label">{label}</div>
      <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: accent ?? "var(--text)" }}>
        {value}
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        padding: "8px 12px",
        fontSize: 12,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.5px",
        color: "var(--text-dim)",
      }}
    >
      {children}
    </th>
  );
}

function OrderRow({ order }: { order: Order }) {
  return (
    <tr style={{ borderBottom: "1px solid var(--border)" }}>
      <Td>
        <Link to={`/checkout/${order.id}`} className="mono" style={{ fontSize: 13 }}>
          {order.id.slice(0, 8)}…
        </Link>
      </Td>
      <Td>${order.quote.usdAmount.toFixed(2)}</Td>
      <Td className="mono">{dropsToXrp(order.quote.xrpAmountDrops)}</Td>
      <Td>
        <StatusBadge status={order.status} />
      </Td>
      <Td>
        {order.settleTxHash ? (
          <a
            href={`${COSTON2_EXPLORER}/tx/${order.settleTxHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mono"
            style={{ fontSize: 13 }}
          >
            {order.settleTxHash.slice(0, 8)}…
          </a>
        ) : (
          <span className="muted">—</span>
        )}
      </Td>
      <Td>
        <Link to={`/checkout/${order.id}`} className="btn btn-sm">
          Open →
        </Link>
      </Td>
    </tr>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={className} style={{ padding: "10px 12px", fontSize: 14 }}>
      {children}
    </td>
  );
}

function computeStats(orders: Order[]) {
  let settled = 0;
  let pending = 0;
  let totalFxrp = 0;

  for (const o of orders) {
    if (o.status === "SETTLED" || o.status === "REDEEMED") {
      settled++;
      if (o.feeBreakdown) {
        totalFxrp += Number(o.feeBreakdown.merchantFxrpDrops) / 1_000_000;
      }
    } else if (!isTerminal(o.status)) {
      pending++;
    }
  }

  return {
    total: orders.length,
    settled,
    pending,
    totalFxrp: totalFxrp.toFixed(4),
  };
}

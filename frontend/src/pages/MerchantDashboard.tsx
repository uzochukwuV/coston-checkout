import { useState, useMemo } from "react";
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

type StatusFilter = "all" | "pending" | "settled" | "expired";

export default function MerchantDashboard() {
  const [usdAmount, setUsdAmount] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
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

  const allOrders = ordersQuery.data ?? [];
  const stats = useMemo(() => computeStats(allOrders), [allOrders]);
  const filteredOrders = useMemo(
    () => filterOrders(allOrders, filter),
    [allOrders, filter],
  );

  return (
    <div className="dash-layout">
      {/* ===== LEFT COLUMN: sidebar with wallet info, stats, create order ===== */}
      <div className="col" style={{ gap: 20 }}>
        {/* Wallet / merchant card */}
        <div className="card">
          <div className="label" style={{ marginBottom: 12 }}>Merchant Wallet</div>
          {isConnected ? (
            <>
              <div className="mono" style={{ fontSize: 13, color: "var(--text-dim)", wordBreak: "break-all", marginBottom: 12 }}>
                {address}
              </div>
              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}>
                <div className="label">FXRP Balance (on-chain)</div>
                <div className="mono" style={{ fontSize: 22, fontWeight: 800, color: "var(--accent)" }}>
                  {fxrpBalance.data !== undefined ? dropsToXrp(fxrpBalance.data.toString()) : "…"}{" "}
                  <span style={{ fontSize: 14, color: "var(--text-dim)" }}>FXRP</span>
                </div>
              </div>
              <a
                href={`${COSTON2_EXPLORER}/address/${address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-sm"
                style={{ marginTop: 12, width: "100%", justifyContent: "center" }}
              >
                View on Explorer →
              </a>
            </>
          ) : (
            <div className="dim" style={{ fontSize: 14, padding: "12px 0" }}>
              Connect your Flare wallet (top-right) to view on-chain FXRP balance and analytics.
            </div>
          )}
        </div>

        {/* Create order card */}
        <div className="card">
          <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Create Checkout Order</h2>
          <form onSubmit={handleCreate} className="col" style={{ gap: 12 }}>
            <div>
              <label className="label">Amount (USD)</label>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)", fontWeight: 600 }}>$</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder="10.00"
                  value={usdAmount}
                  onChange={(e) => setUsdAmount(e.target.value)}
                  disabled={createMutation.isPending}
                  style={{ paddingLeft: 28 }}
                />
              </div>
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={createMutation.isPending || !usdAmount}
              style={{ width: "100%", justifyContent: "center" }}
            >
              {createMutation.isPending ? "Creating…" : "Create Order"}
            </button>
          </form>
          {createMutation.isError && (
            <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>
              {(createMutation.error as Error).message}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button
              className="btn btn-sm"
              onClick={() => pollMutation.mutate()}
              disabled={pollMutation.isPending}
              type="button"
              style={{ flex: 1, justifyContent: "center" }}
            >
              {pollMutation.isPending ? "…" : "Poll Now"}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => expireMutation.mutate()}
              disabled={expireMutation.isPending}
              type="button"
              style={{ flex: 1, justifyContent: "center" }}
            >
              Expire Stale
            </button>
          </div>
        </div>

        {/* API health */}
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              className="badge"
              style={{
                background: healthQuery.data?.ok ? "var(--success-light)" : "var(--danger-light)",
                color: healthQuery.data?.ok ? "var(--success)" : "var(--danger)",
              }}
            >
              ● {healthQuery.data?.ok ? "API Online" : "API Offline"}
            </span>
          </div>
        </div>
      </div>

      {/* ===== RIGHT COLUMN: analytics + orders table ===== */}
      <div className="col" style={{ gap: 20 }}>
        {/* Page header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h1 style={{ fontSize: 24, fontWeight: 800 }}>Merchant Dashboard</h1>
        </div>

        {/* Analytics stat cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
          <StatCard label="Total Orders" value={stats.total.toString()} />
          <StatCard label="Settled" value={stats.settled.toString()} accent="var(--success)" />
          <StatCard label="Pending" value={stats.pending.toString()} accent="var(--warning)" />
          <StatCard label="Total FXRP" value={stats.totalFxrp} accent="var(--accent)" />
        </div>

        {/* Revenue + bar chart card */}
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <div className="label" style={{ marginBottom: 0 }}>Volume (last 10 orders)</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 800, color: "var(--accent)" }}>
              ${stats.totalUsd.toFixed(2)}
            </div>
          </div>
          <div className="bar-chart">
            {stats.barData.map((h, i) => (
              <div
                key={i}
                className={`bar ${i === stats.barData.length - 1 ? "active" : ""}`}
                style={{ height: `${h}%` }}
                title={`$${(stats.barUsd[i] ?? 0).toFixed(2)}`}
              />
            ))}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            USD volume per order · newest on the right
          </div>
        </div>

        {/* Orders table with filters */}
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
            <h2 style={{ fontSize: 15, fontWeight: 700 }}>All Orders</h2>
            <div style={{ display: "flex", gap: 6 }}>
              {(["all", "pending", "settled", "expired"] as StatusFilter[]).map((f) => (
                <button
                  key={f}
                  className={`filter-pill ${filter === f ? "active" : ""}`}
                  onClick={() => setFilter(f)}
                >
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          </div>
          {ordersQuery.isLoading ? (
            <div className="dim" style={{ padding: 20, textAlign: "center" }}>Loading orders…</div>
          ) : filteredOrders.length === 0 ? (
            <div className="dim" style={{ padding: 32, textAlign: "center" }}>
              No {filter !== "all" ? filter : ""} orders yet. Create one from the sidebar to get started.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="orders-table">
                <thead>
                  <tr>
                    <th>Order ID</th>
                    <th>USD</th>
                    <th>XRP</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Settle Tx</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOrders.map((order) => (
                    <OrderRow key={order.id} order={order} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color: accent ?? "var(--text)" }}>
        {value}
      </div>
    </div>
  );
}

function OrderRow({ order }: { order: Order }) {
  const created = new Date(order.createdAt * 1000);
  return (
    <tr>
      <td>
        <Link to={`/checkout/${order.id}`} className="mono" style={{ fontSize: 13 }}>
          {order.id}
        </Link>
      </td>
      <td>${order.quote.usdAmount.toFixed(2)}</td>
      <td className="mono">{dropsToXrp(order.quote.xrpAmountDrops)}</td>
      <td>
        <StatusBadge status={order.status} />
      </td>
      <td className="dim" style={{ fontSize: 13 }}>
        {created.toLocaleDateString()} {created.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </td>
      <td>
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
        ) : order.refundTxHash ? (
          <span className="badge badge-info" title={`Refund tx: ${order.refundTxHash}`}>
            Refunded
          </span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        <Link to={`/checkout/${order.id}`} className="btn btn-sm">
          Open →
        </Link>
      </td>
    </tr>
  );
}

function filterOrders(orders: Order[], filter: StatusFilter): Order[] {
  switch (filter) {
    case "pending":
      return orders.filter((o) => !isTerminal(o.status));
    case "settled":
      return orders.filter((o) => o.status === "SETTLED" || o.status === "REDEEMED");
    case "expired":
      return orders.filter(
        (o) => o.status === "EXPIRED" || o.status === "FAILED" || o.status === "REFUNDED",
      );
    default:
      return orders;
  }
}

function computeStats(orders: Order[]) {
  let settled = 0;
  let pending = 0;
  let totalFxrp = 0;
  let totalUsd = 0;

  for (const o of orders) {
    if (o.status === "SETTLED" || o.status === "REDEEMED") {
      settled++;
      if (o.feeBreakdown) {
        totalFxrp += Number(o.feeBreakdown.merchantFxrpDrops) / 1_000_000;
      }
      totalUsd += o.quote.usdAmount;
    } else if (!isTerminal(o.status)) {
      pending++;
      totalUsd += o.quote.usdAmount;
    }
  }

  // Bar chart: USD volume of last 10 orders, newest last
  const recent = orders.slice(0, 10);
  const barUsd = recent.map((o) => o.quote.usdAmount);
  const maxUsd = Math.max(...barUsd, 1);
  const barData = barUsd.map((usd) => Math.max(5, (usd / maxUsd) * 100));

  return {
    total: orders.length,
    settled,
    pending,
    totalFxrp: totalFxrp.toFixed(4),
    totalUsd,
    barData,
    barUsd,
  };
}

import { Routes, Route, Link, useLocation } from "react-router-dom";
import CheckoutPage from "./pages/CheckoutPage";
import MerchantDashboard from "./pages/MerchantDashboard";
import { WalletBar } from "./components/WalletBar";

export default function App() {
  const loc = useLocation();
  const isCheckout = loc.pathname.startsWith("/checkout");

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <nav
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 32px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-card)",
          boxShadow: "var(--shadow-sm)",
          position: "sticky",
          top: 0,
          zIndex: 50,
        }}
      >
        <Link to="/" style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text)", textDecoration: "none" }}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <rect width="28" height="28" rx="7" fill="var(--accent)" />
            <path d="M8 8L20 20M20 8L8 20" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
          </svg>
          <span style={{ fontWeight: 800, fontSize: 18, color: "var(--text)" }}>
            FXRP<span style={{ color: "var(--accent)" }}>Checkout</span>
          </span>
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", gap: 4 }}>
            <Link
              to="/"
              className={`nav-item ${!isCheckout ? "active" : ""}`}
              style={{ textDecoration: "none" }}
            >
              Dashboard
            </Link>
            <Link
              to="/checkout"
              className={`nav-item ${isCheckout ? "active" : ""}`}
              style={{ textDecoration: "none" }}
            >
              Checkout
            </Link>
          </div>
          <WalletBar />
        </div>
      </nav>
      <main style={{ flex: 1, maxWidth: 1200, width: "100%", margin: "0 auto", padding: "32px 24px" }}>
        <Routes>
          <Route path="/" element={<MerchantDashboard />} />
          <Route path="/checkout" element={<CheckoutPage />} />
          <Route path="/checkout/:orderId" element={<CheckoutPage />} />
          <Route path="*" element={<MerchantDashboard />} />
        </Routes>
      </main>
      <footer
        style={{
          textAlign: "center",
          padding: "20px",
          borderTop: "1px solid var(--border)",
          color: "var(--text-muted)",
          fontSize: 13,
        }}
      >
        Gasless FXRP Checkout · Flare Coston2 · FAssets + FDC + FTSO + Smart Accounts
      </footer>
    </div>
  );
}

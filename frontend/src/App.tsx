import { Routes, Route, Link, useLocation } from "react-router-dom";
import CheckoutPage from "./pages/CheckoutPage";
import MerchantDashboard from "./pages/MerchantDashboard";

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
          padding: "16px 32px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-card)",
        }}
      >
        <Link to="/" style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text)", textDecoration: "none" }}>
          <span style={{ color: "var(--accent)", fontWeight: 800, fontSize: 20 }}>FXRP</span>
          <span className="dim" style={{ fontSize: 14 }}>Checkout</span>
        </Link>
        <div style={{ display: "flex", gap: 8 }}>
          <Link
            to="/"
            className={`btn btn-sm ${!isCheckout ? "btn-primary" : ""}`}
            style={{ textDecoration: "none" }}
          >
            Merchant
          </Link>
          <Link
            to="/checkout"
            className={`btn btn-sm ${isCheckout ? "btn-primary" : ""}`}
            style={{ textDecoration: "none" }}
          >
            Checkout
          </Link>
        </div>
      </nav>
      <main style={{ flex: 1, maxWidth: 960, width: "100%", margin: "0 auto", padding: "32px 24px" }}>
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

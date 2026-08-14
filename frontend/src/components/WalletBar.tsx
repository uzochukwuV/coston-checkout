/**
 * WalletBar — shows Flare (EVM) and XRP wallet connection buttons.
 * Flare uses wagmi's useAccount/useConnect/useDisconnect.
 * XRP uses the Crossmark extension (or manual entry fallback).
 */

import { useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { useXrpWalletContext } from "./XrpWalletProvider";

export function WalletBar() {
  const { address, isConnected } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnect } = useDisconnect();
  const xrp = useXrpWalletContext();
  const [showMenu, setShowMenu] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [manualAddr, setManualAddr] = useState("");

  const handleFlareConnect = async () => {
    try {
      const injected = connectors.find((c) => c.type === "injected") ?? connectors[0];
      if (injected) await connectAsync({ connector: injected });
    } catch (e) {
      console.error("Flare connect failed:", e);
    }
  };

  return (
    <div style={{ position: "relative", display: "flex", gap: 10 }}>
      {/* Flare wallet */}
      {isConnected ? (
        <button className="wallet-btn connected" onClick={() => disconnect()} title="Disconnect Flare wallet">
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--success)" }} />
          <span className="mono" style={{ fontSize: 12 }}>
            {address?.slice(0, 5)}…{address?.slice(-3)}
          </span>
          <span className="dim" style={{ fontSize: 11 }}>Flare</span>
        </button>
      ) : (
        <button className="wallet-btn" onClick={handleFlareConnect}>
          <FlareIcon />
          <span>Connect Flare</span>
        </button>
      )}

      {/* XRP wallet */}
      {xrp.connected ? (
        <button className="wallet-btn connected" onClick={xrp.disconnect} title="Disconnect XRP wallet">
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--success)" }} />
          <span className="mono" style={{ fontSize: 12 }}>
            {xrp.address!.slice(0, 5)}…{xrp.address!.slice(-3)}
          </span>
          <span className="dim" style={{ fontSize: 11 }}>XRP{xrp.network ? ` · ${xrp.network}` : ""}</span>
        </button>
      ) : (
        <div style={{ position: "relative" }}>
          <button
            className="wallet-btn"
            onClick={() => setShowMenu(!showMenu)}
          >
            <XrpIcon />
            <span>Connect XRP</span>
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>▾</span>
          </button>
          {showMenu && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                marginTop: 8,
                zIndex: 100,
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                boxShadow: "var(--shadow-lg)",
                padding: 8,
                minWidth: 220,
              }}
            >
              {xrp.hasExtension ? (
                <button
                  className="btn btn-sm"
                  style={{ width: "100%", justifyContent: "flex-start", marginBottom: 4 }}
                  onClick={async () => {
                    await xrp.connect();
                    setShowMenu(false);
                  }}
                  disabled={xrp.connecting}
                >
                  <XrpIcon /> {xrp.connecting ? "Connecting…" : "Crossmark"}
                </button>
              ) : (
                <div style={{ marginBottom: 4 }}>
                  <div className="dim" style={{ padding: "8px 10px", fontSize: 12, marginBottom: 4 }}>
                    Crossmark extension not detected.
                  </div>
                  <a
                    href="https://crossmark.io/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-sm"
                    style={{ width: "100%", justifyContent: "center", fontSize: 12 }}
                  >
                    Install Crossmark →
                  </a>
                </div>
              )}
              <button
                className="btn btn-sm"
                style={{ width: "100%", justifyContent: "flex-start" }}
                onClick={() => {
                  setShowMenu(false);
                  setShowManual(true);
                }}
              >
                ✎ Enter address manually
              </button>
            </div>
          )}
        </div>
      )}

      {/* Manual XRP entry modal */}
      {showManual && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.3)",
            zIndex: 200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={() => setShowManual(false)}
        >
          <div
            className="card"
            style={{ maxWidth: 400, width: "90%" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Connect XRP Wallet</h3>
            <p className="dim" style={{ fontSize: 14, marginBottom: 16 }}>
              Enter your XRPL account address (starts with "r"). This is a read-only connection
              — to sign payments, install the <a href="https://crossmark.io/" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>Crossmark</a> extension.
            </p>
            <input
              className="input"
              placeholder="rDsbeomae4o4Jx3F2..."
              value={manualAddr}
              onChange={(e) => setManualAddr(e.target.value)}
              autoFocus
            />
            <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
              <button className="btn btn-sm" onClick={() => setShowManual(false)}>
                Cancel
              </button>
              <button
                className="btn btn-sm btn-primary"
                onClick={() => {
                  xrp.connectManual(manualAddr);
                  setShowManual(false);
                  setManualAddr("");
                }}
                disabled={!manualAddr.trim().startsWith("r") || manualAddr.trim().length < 25}
              >
                Connect
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FlareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 2L4 7v10l8 5 8-5V7l-8-5z"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M12 7v10M8 9.5v5M16 9.5v5" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function XrpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 7L17 17M17 7L7 17"
        stroke="var(--text)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="10" stroke="var(--text)" strokeWidth="1.5" fill="none" opacity="0.3" />
    </svg>
  );
}

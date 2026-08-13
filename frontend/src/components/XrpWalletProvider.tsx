/**
 * XRP wallet context — shares the useXrpWallet state across the app
 * so the WalletBar (nav) and the CheckoutPage (payment) see the same connection.
 */

import { createContext, useContext, type ReactNode } from "react";
import { useXrpWallet, type XrpWalletState } from "../hooks/useXrpWallet";

const XrpWalletContext = createContext<XrpWalletState | null>(null);

export function XrpWalletProvider({ children }: { children: ReactNode }) {
  const wallet = useXrpWallet();
  return <XrpWalletContext.Provider value={wallet}>{children}</XrpWalletContext.Provider>;
}

export function useXrpWalletContext(): XrpWalletState {
  const ctx = useContext(XrpWalletContext);
  if (!ctx) throw new Error("useXrpWalletContext must be used within XrpWalletProvider");
  return ctx;
}

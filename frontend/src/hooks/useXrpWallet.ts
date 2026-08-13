/**
 * XRP wallet hook — connects via the Crossmark browser extension if available,
 * or falls back to manual address entry. Crossmark injects `window.crossmark`
 * with a `signIn()` / `signOut()` API.
 *
 * The connected XRP address is persisted to localStorage so it survives reloads.
 */

import { useCallback, useEffect, useState } from "react";

export interface XrpWalletState {
  address: string | null;
  connected: boolean;
  connecting: boolean;
  hasExtension: boolean;
  connect: () => Promise<void>;
  connectManual: (address: string) => void;
  disconnect: () => void;
}

const STORAGE_KEY = "fxrp_xrp_address";

/** Minimal Crossmark injected type. */
interface CrossmarkApi {
  signIn: () => Promise<{ response: { account: { address: string } } }>;
  signOut: () => Promise<void>;
}

declare global {
  interface Window {
    crossmark?: CrossmarkApi;
  }
}

export function useXrpWallet(): XrpWalletState {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [hasExtension, setHasExtension] = useState(false);

  // On mount: restore from localStorage, detect extension
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) setAddress(saved);
    setHasExtension(typeof window !== "undefined" && !!window.crossmark);

    // Watch for extension injection (it may load after our script)
    if (typeof window !== "undefined" && !window.crossmark) {
      const interval = setInterval(() => {
        if (window.crossmark) {
          setHasExtension(true);
          clearInterval(interval);
        }
      }, 1000);
      return () => clearInterval(interval);
    }
  }, []);

  const connect = useCallback(async () => {
    if (window.crossmark) {
      setConnecting(true);
      try {
        const res = await window.crossmark.signIn();
        const addr = res.response.account.address;
        setAddress(addr);
        localStorage.setItem(STORAGE_KEY, addr);
      } catch (e) {
        console.error("Crossmark sign-in failed:", e);
      } finally {
        setConnecting(false);
      }
    }
  }, []);

  const connectManual = useCallback((addr: string) => {
    const trimmed = addr.trim();
    if (trimmed && trimmed.startsWith("r") && trimmed.length >= 25) {
      setAddress(trimmed);
      localStorage.setItem(STORAGE_KEY, trimmed);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    localStorage.removeItem(STORAGE_KEY);
    if (window.crossmark) {
      window.crossmark.signOut().catch(() => {});
    }
  }, []);

  return {
    address,
    connected: !!address,
    connecting,
    hasExtension,
    connect,
    connectManual,
    disconnect,
  };
}

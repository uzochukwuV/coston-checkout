/**
 * XRP wallet hook — connects via the Crossmark browser extension SDK.
 * Supports real transaction signing + submission (not just read-only).
 * Falls back to manual address entry if the extension is not installed.
 *
 * The connected XRP address is persisted to localStorage so it survives reloads.
 */

import { useCallback, useEffect, useState } from "react";

/** Result of a sign+submit call. */
export interface XrpTxResult {
  hash: string;
}

export interface XrpWalletState {
  address: string | null;
  connected: boolean;
  connecting: boolean;
  hasExtension: boolean;
  /** Network label from Crossmark (e.g. "xahara-testnet", "xrpl-testnet"). */
  network: string | null;
  connect: () => Promise<void>;
  connectManual: (address: string) => void;
  disconnect: () => void;
  /**
   * Sign and submit an XRPL Payment transaction via Crossmark.
   * @param tx Partial Payment transaction (Account is filled automatically from connected address).
   * @returns transaction hash on success
   */
  signAndSubmitPayment: (tx: Record<string, unknown>) => Promise<XrpTxResult>;
}

const STORAGE_KEY = "fxrp_xrp_address";

export function useXrpWallet(): XrpWalletState {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [hasExtension, setHasExtension] = useState(false);
  const [network, setNetwork] = useState<string | null>(null);

  // Lazily get the Crossmark SDK instance (injected by the extension).
  const getSdk = useCallback((): any | null => {
    if (typeof window === "undefined") return null;
    // The extension injects `window.crossmark` as an SDK instance.
    return (window as any).crossmark ?? null;
  }, []);

  // On mount: restore from localStorage, detect extension
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) setAddress(saved);

    const check = () => {
      const sdk = getSdk();
      if (sdk) {
        setHasExtension(true);
        // If already signed in from a previous session, restore the address
        try {
          const sessionAddr = sdk?.session?.address ?? sdk?.sync?.getAddress?.();
          if (sessionAddr && !saved) {
            setAddress(sessionAddr);
            localStorage.setItem(STORAGE_KEY, sessionAddr);
          }
          const net = sdk?.session?.network?.label ?? sdk?.sync?.getNetwork?.()?.label ?? null;
          if (net) setNetwork(net);
        } catch {
          // session not available yet — that's fine
        }
        return true;
      }
      return false;
    };

    if (!check()) {
      // Watch for extension injection (it may load after our script)
      const interval = setInterval(() => {
        if (check()) clearInterval(interval);
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [getSdk]);

  const connect = useCallback(async () => {
    const sdk = getSdk();
    if (!sdk) return;

    setConnecting(true);
    try {
      // Crossmark SDK async API: signInAndWait()
      const resp = await sdk.async.signInAndWait();
      const data = resp?.response?.data;
      if (data?.address) {
        setAddress(data.address);
        localStorage.setItem(STORAGE_KEY, data.address);
      }
      if (data?.network?.label) {
        setNetwork(data.network.label);
      }
    } catch (e) {
      console.error("Crossmark sign-in failed:", e);
    } finally {
      setConnecting(false);
    }
  }, [getSdk]);

  const connectManual = useCallback((addr: string) => {
    const trimmed = addr.trim();
    if (trimmed && trimmed.startsWith("r") && trimmed.length >= 25) {
      setAddress(trimmed);
      localStorage.setItem(STORAGE_KEY, trimmed);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    setNetwork(null);
    localStorage.removeItem(STORAGE_KEY);
    const sdk = getSdk();
    if (sdk?.async?.signOutAndWait) {
      sdk.async.signOutAndWait().catch(() => {});
    }
  }, [getSdk]);

  const signAndSubmitPayment = useCallback(
    async (tx: Record<string, unknown>): Promise<XrpTxResult> => {
      const sdk = getSdk();
      if (!sdk) throw new Error("Crossmark extension not available");
      if (!address) throw new Error("XRP wallet not connected");

      // Ensure Account is set to the connected address
      const fullTx = { ...tx, Account: address };

      // Crossmark handles autofill (Sequence, Fee, LastLedgerSequence, etc.)
      const resp = await sdk.async.signAndSubmitAndWait(fullTx, {
        description: "FXRP direct minting payment to Flare Core Vault",
      });

      const meta = resp?.response?.data?.meta;
      if (meta?.isRejected) throw new Error("Transaction rejected by user");
      if (meta?.isError) throw new Error("Transaction failed in wallet");

      const hash = resp?.response?.data?.resp?.result?.hash;
      if (!hash) throw new Error("No transaction hash returned");
      return { hash };
    },
    [getSdk, address],
  );

  return {
    address,
    connected: !!address,
    connecting,
    hasExtension,
    network,
    connect,
    connectManual,
    disconnect,
    signAndSubmitPayment,
  };
}

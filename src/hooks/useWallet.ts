import { useCallback, useEffect, useState } from "react";
import {
  openWalletModal,
  disconnectWallet,
  getConnectedAddress,
} from "@/lib/wallet";
import type { StellarNetwork } from "@/lib/cctp";

const ADDR_KEY = "cctp:address";
const NET_KEY = "cctp:network";

export function useWallet() {
  const [network, setNetworkState] = useState<StellarNetwork>(() => {
    const stored = localStorage.getItem(NET_KEY) as StellarNetwork | null;
    return stored === "mainnet" || stored === "testnet" ? stored : "testnet";
  });
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const stored = localStorage.getItem(ADDR_KEY);
    if (!stored) return;
    (async () => {
      try {
        const addr = await getConnectedAddress(network);
        if (!cancelled) setAddress(addr ?? stored);
      } catch {
        if (!cancelled) setAddress(stored);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [network]);

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const { address } = await openWalletModal(network);
      setAddress(address);
      localStorage.setItem(ADDR_KEY, address);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setConnecting(false);
    }
  }, [network]);

  const disconnect = useCallback(async () => {
    try {
      await disconnectWallet();
    } catch {
      // ignore
    }
    setAddress(null);
    localStorage.removeItem(ADDR_KEY);
  }, []);

  const setNetwork = useCallback(
    async (net: StellarNetwork) => {
      if (net === network) return;
      await disconnect();
      setNetworkState(net);
      localStorage.setItem(NET_KEY, net);
    },
    [network, disconnect],
  );

  return {
    network,
    setNetwork,
    address,
    connect,
    disconnect,
    connecting,
    error,
  };
}

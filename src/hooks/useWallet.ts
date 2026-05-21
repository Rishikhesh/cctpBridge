import { useCallback, useEffect, useState } from "react";
import {
  disconnectWallet,
  getConnectedAddress,
  setActiveWalletId,
} from "@/lib/wallet";
import type { StellarNetwork } from "@/lib/cctp";

const ADDR_KEY = "cctp:address";
const NET_KEY = "cctp:network";
const WALLET_ID_KEY = "cctp:stellarWalletId";

export function useWallet() {
  const [network, setNetworkState] = useState<StellarNetwork>(() => {
    const stored = localStorage.getItem(NET_KEY) as StellarNetwork | null;
    return stored === "mainnet" || stored === "testnet" ? stored : "mainnet";
  });
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const storedAddr = localStorage.getItem(ADDR_KEY);
    const storedWalletId = localStorage.getItem(WALLET_ID_KEY);
    if (!storedAddr) return;

    // Restore the previously-selected wallet module on the kit BEFORE doing
    // any reads/signs — otherwise the kit defaults back to Freighter and any
    // sign call surfaces "Freighter is not connected" even though we paired
    // via WalletConnect / LOBSTR / xBull etc.
    if (storedWalletId) {
      try {
        setActiveWalletId(network, storedWalletId);
      } catch {
        // ignore — fallback to address-only restore
      }
    }

    (async () => {
      try {
        const addr = await getConnectedAddress(network);
        if (!cancelled) setAddress(addr ?? storedAddr);
      } catch {
        if (!cancelled) setAddress(storedAddr);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [network]);

  const connect = useCallback(async () => {
    setError(null);
    setPickerOpen(true);
  }, []);

  const handleConnected = useCallback((addr: string, walletId?: string) => {
    setAddress(addr);
    localStorage.setItem(ADDR_KEY, addr);
    if (walletId) localStorage.setItem(WALLET_ID_KEY, walletId);
    setConnecting(false);
  }, []);

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    setConnecting(false);
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await disconnectWallet();
    } catch {
      // ignore
    }
    setAddress(null);
    setError(null);
    setConnecting(false);
    setPickerOpen(false);
    localStorage.removeItem(ADDR_KEY);
    localStorage.removeItem(WALLET_ID_KEY);
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
    pickerOpen,
    closePicker,
    handleConnected,
  };
}

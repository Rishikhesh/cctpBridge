import { useCallback, useEffect, useState } from "react";
import {
  evmChainId,
  evmConnect,
  evmSwitchChain,
  hasEthereumProvider,
} from "@/lib/evm";
import type { ChainInfo } from "@/lib/cctp";

const KEY = "cctp:evmAddress";

export function useEvmWallet() {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const provider = typeof window !== "undefined" ? window.ethereum : undefined;
  const available = hasEthereumProvider();

  useEffect(() => {
    if (!provider) return;
    const stored = localStorage.getItem(KEY);
    if (stored) setAddress(stored);
    (async () => {
      try {
        const id = await evmChainId();
        setChainId(id);
      } catch {
        // ignore
      }
    })();
    const onAccounts = (...args: unknown[]) => {
      const accs = args[0] as string[];
      const next = accs?.[0] ?? null;
      setAddress(next);
      if (next) localStorage.setItem(KEY, next);
      else localStorage.removeItem(KEY);
    };
    const onChain = (...args: unknown[]) => {
      const hex = args[0] as string;
      setChainId(parseInt(hex, 16));
    };
    provider.on?.("accountsChanged", onAccounts);
    provider.on?.("chainChanged", onChain);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, [provider]);

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const a = await evmConnect();
      setAddress(a);
      localStorage.setItem(KEY, a);
      const id = await evmChainId();
      setChainId(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchToChain = useCallback(async (chain: ChainInfo) => {
    if (!chain.evm) throw new Error("No EVM config");
    await evmSwitchChain(chain);
    setChainId(chain.evm.chainId);
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    localStorage.removeItem(KEY);
  }, []);

  return {
    available,
    address,
    chainId,
    connect,
    disconnect,
    switchToChain,
    connecting,
    error,
  };
}

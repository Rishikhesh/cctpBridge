import { useCallback, useEffect, useState } from "react";
import {
  getSolanaProvider,
  hasSolanaProvider,
  solanaConnect,
  solanaDisconnect,
  solanaSilentConnect,
} from "@/lib/solana";

const KEY = "cctp:solanaAddress";

export function useSolanaWallet() {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = hasSolanaProvider();

  useEffect(() => {
    const stored = localStorage.getItem(KEY);
    if (stored) setAddress(stored);
    (async () => {
      const live = await solanaSilentConnect();
      if (live) {
        setAddress(live);
        localStorage.setItem(KEY, live);
      }
    })();
    const provider = getSolanaProvider();
    if (!provider) return;
    const onConnect = (...args: unknown[]) => {
      const pk = (args[0] as { toString: () => string } | undefined)?.toString();
      if (pk) {
        setAddress(pk);
        localStorage.setItem(KEY, pk);
      }
    };
    const onDisconnect = () => {
      setAddress(null);
      localStorage.removeItem(KEY);
    };
    provider.on?.("connect", onConnect);
    provider.on?.("disconnect", onDisconnect);
    return () => {
      provider.off?.("connect", onConnect);
      provider.off?.("disconnect", onDisconnect);
    };
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const a = await solanaConnect();
      setAddress(a);
      localStorage.setItem(KEY, a);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await solanaDisconnect();
    } catch {
      // ignore
    }
    setAddress(null);
    localStorage.removeItem(KEY);
  }, []);

  return { available, address, connecting, error, connect, disconnect };
}

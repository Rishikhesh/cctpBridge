import { useCallback, useEffect, useState } from "react";
import {
  getSolanaProvider,
  hasSolanaProvider,
  solanaConnect,
  solanaDisconnect,
  solanaSilentConnect,
} from "@/lib/solana";
import { formatError } from "@/lib/utils";

const KEY = "cctp:solanaAddress";

export function useSolanaWallet() {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = hasSolanaProvider();

  useEffect(() => {
    // Only mark address connected if Phantom confirms via onlyIfTrusted
    // (proves prior in-app connect). Do not pre-fill from localStorage.
    (async () => {
      const live = await solanaSilentConnect();
      if (live) {
        setAddress(live);
        localStorage.setItem(KEY, live);
      } else {
        localStorage.removeItem(KEY);
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
      setError(formatError(e));
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
    setError(null);
    setConnecting(false);
    localStorage.removeItem(KEY);
  }, []);

  return { available, address, connecting, error, connect, disconnect };
}

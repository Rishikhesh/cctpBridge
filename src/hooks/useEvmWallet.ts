import { useCallback, useEffect, useRef, useState } from "react";
import {
  evmChainId,
  evmConnect,
  evmSwitchChain,
  hasEthereumProvider,
  hasInjectedEthereum,
  setActiveEvmProvider,
  type EvmProviderKind,
  type InjectedEvmProvider,
} from "@/lib/evm";
import {
  WC_EVM_ENABLED,
  getWcEvmProvider,
  wcEvmConnect,
  wcEvmDisconnect,
  wcEvmHasSession,
} from "@/lib/evm-walletconnect";
import type { ChainInfo } from "@/lib/cctp";

const KEY_ADDR = "cctp:evmAddress";
const KEY_KIND = "cctp:evmKind";

export function useEvmWallet() {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [providerKind, setProviderKind] = useState<EvmProviderKind | null>(
    null,
  );
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const available = hasEthereumProvider() || WC_EVM_ENABLED;
  const injectedAvailable = hasInjectedEthereum();
  const wcAvailable = WC_EVM_ENABLED;

  const attachListeners = useCallback(
    (provider: InjectedEvmProvider, kind: EvmProviderKind) => {
      cleanupRef.current?.();
      const onAccounts = (...args: unknown[]) => {
        const accs = args[0] as string[];
        const next = accs?.[0] ?? null;
        setAddress(next);
        if (next) {
          localStorage.setItem(KEY_ADDR, next);
          localStorage.setItem(KEY_KIND, kind);
        } else {
          localStorage.removeItem(KEY_ADDR);
          localStorage.removeItem(KEY_KIND);
        }
      };
      const onChain = (...args: unknown[]) => {
        const v = args[0];
        if (typeof v === "string") setChainId(parseInt(v, 16));
        else if (typeof v === "number") setChainId(v);
      };
      const onDisconnect = () => {
        setAddress(null);
        setProviderKind(null);
        setActiveEvmProvider(null, null);
        localStorage.removeItem(KEY_ADDR);
        localStorage.removeItem(KEY_KIND);
      };
      provider.on?.("accountsChanged", onAccounts);
      provider.on?.("chainChanged", onChain);
      provider.on?.("disconnect", onDisconnect);
      cleanupRef.current = () => {
        provider.removeListener?.("accountsChanged", onAccounts);
        provider.removeListener?.("chainChanged", onChain);
        provider.removeListener?.("disconnect", onDisconnect);
      };
    },
    [],
  );

  // Restore prior session on mount (injected reads `eth_accounts`,
  // WC restores via existing signClient session).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const kind = localStorage.getItem(KEY_KIND) as EvmProviderKind | null;
      if (kind === "walletconnect" && WC_EVM_ENABLED) {
        try {
          const p = await getWcEvmProvider();
          if (wcEvmHasSession()) {
            setActiveEvmProvider(
              p as unknown as InjectedEvmProvider,
              "walletconnect",
            );
            attachListeners(p as unknown as InjectedEvmProvider, "walletconnect");
            const accs = (await p.request({
              method: "eth_accounts",
            })) as string[];
            if (!cancelled && accs?.[0]) {
              setAddress(accs[0]);
              setProviderKind("walletconnect");
              try {
                setChainId(await evmChainId());
              } catch {
                // ignore
              }
            }
          }
        } catch {
          // ignore
        }
        return;
      }
      if (injectedAvailable) {
        const provider = readInjectedRaw();
        if (!provider) return;
        setActiveEvmProvider(provider, "injected");
        attachListeners(provider, "injected");
        const stored = localStorage.getItem(KEY_ADDR);
        if (stored) setAddress(stored);
        try {
          const id = await evmChainId();
          if (!cancelled) setChainId(id);
          const accs = (await provider.request({
            method: "eth_accounts",
          })) as string[];
          if (!cancelled && accs?.[0]) {
            setAddress(accs[0]);
            setProviderKind("injected");
            localStorage.setItem(KEY_ADDR, accs[0]);
            localStorage.setItem(KEY_KIND, "injected");
          }
        } catch {
          // ignore
        }
      }
    })();
    return () => {
      cancelled = true;
      cleanupRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectInjected = useCallback(async () => {
    const provider = readInjectedRaw();
    if (!provider) {
      throw new Error(
        "No injected wallet detected. Install MetaMask, Rabby, or use WalletConnect.",
      );
    }
    setActiveEvmProvider(provider, "injected");
    attachListeners(provider, "injected");
    const a = await evmConnect();
    setAddress(a);
    setProviderKind("injected");
    localStorage.setItem(KEY_ADDR, a);
    localStorage.setItem(KEY_KIND, "injected");
    try {
      setChainId(await evmChainId());
    } catch {
      // ignore
    }
  }, [attachListeners]);

  const connectWalletConnect = useCallback(async () => {
    if (!WC_EVM_ENABLED) {
      throw new Error(
        "WalletConnect disabled — set VITE_WALLETCONNECT_PROJECT_ID in .env.local",
      );
    }
    // WalletConnect v2 has a page-singleton Core. Refuse to pair a second WC
    // session while another (Stellar) is live — they'd collide on storage +
    // relay subscriptions. Recommend a browser wallet for the other chain.
    if (localStorage.getItem("cctp:stellarWalletId") === "wallet_connect") {
      throw new Error(
        "Disconnect your Stellar WalletConnect session first. WalletConnect can only run one chain at a time per page. Use a browser wallet for the other chain to use both at once.",
      );
    }
    const p = await getWcEvmProvider();
    setActiveEvmProvider(
      p as unknown as InjectedEvmProvider,
      "walletconnect",
    );
    attachListeners(p as unknown as InjectedEvmProvider, "walletconnect");
    const a = await wcEvmConnect();
    setAddress(a);
    setProviderKind("walletconnect");
    localStorage.setItem(KEY_ADDR, a);
    localStorage.setItem(KEY_KIND, "walletconnect");
    try {
      setChainId(await evmChainId());
    } catch {
      // ignore
    }
  }, [attachListeners]);

  const connect = useCallback(async () => {
    setError(null);
    // If only one option is available, pick it directly.
    if (injectedAvailable && !wcAvailable) {
      setConnecting(true);
      try {
        await connectInjected();
      } catch (e) {
        setError(stringifyErr(e));
      } finally {
        setConnecting(false);
      }
      return;
    }
    if (wcAvailable && !injectedAvailable) {
      setConnecting(true);
      try {
        await connectWalletConnect();
      } catch (e) {
        setError(stringifyErr(e));
      } finally {
        setConnecting(false);
      }
      return;
    }
    // Both — show picker.
    setPickerOpen(true);
  }, [injectedAvailable, wcAvailable, connectInjected, connectWalletConnect]);

  const pickInjected = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      await connectInjected();
      setPickerOpen(false);
    } catch (e) {
      setError(stringifyErr(e));
    } finally {
      setConnecting(false);
    }
  }, [connectInjected]);

  const pickWalletConnect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      await connectWalletConnect();
      setPickerOpen(false);
    } catch (e) {
      setError(stringifyErr(e));
    } finally {
      setConnecting(false);
    }
  }, [connectWalletConnect]);

  const switchToChain = useCallback(async (chain: ChainInfo) => {
    if (!chain.evm) throw new Error("No EVM config");
    await evmSwitchChain(chain);
    setChainId(chain.evm.chainId);
  }, []);

  const disconnect = useCallback(async () => {
    if (providerKind === "walletconnect") {
      await wcEvmDisconnect();
    }
    cleanupRef.current?.();
    cleanupRef.current = null;
    setActiveEvmProvider(null, null);
    setAddress(null);
    setChainId(null);
    setProviderKind(null);
    setError(null);
    setConnecting(false);
    setPickerOpen(false);
    localStorage.removeItem(KEY_ADDR);
    localStorage.removeItem(KEY_KIND);
  }, [providerKind]);

  return {
    available,
    injectedAvailable,
    wcAvailable,
    address,
    chainId,
    providerKind,
    connect,
    disconnect,
    switchToChain,
    connecting,
    error,
    pickerOpen,
    closePicker: () => setPickerOpen(false),
    pickInjected,
    pickWalletConnect,
  };
}

function readInjectedRaw(): InjectedEvmProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { ethereum?: unknown };
  if (!w.ethereum) return null;
  return w.ethereum as InjectedEvmProvider;
}

import { formatError as stringifyErrShared } from "@/lib/utils";
function stringifyErr(e: unknown): string {
  return stringifyErrShared(e);
}

import { useEffect, useState } from "react";
import { Loader2, Wallet } from "lucide-react";
import type { ISupportedWallet } from "@creit.tech/stellar-wallets-kit";
import { Modal } from "./Modal";
import { listAvailableWallets, selectWallet } from "@/lib/wallet";
import type { StellarNetwork } from "@/lib/cctp";
import { cn } from "@/lib/utils";

function stringifyErr(e: unknown): string {
  if (!e) return "Unknown error";
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (typeof e === "object") {
    const obj = e as Record<string, unknown>;
    const msg = obj.message ?? obj.error ?? obj.shortMessage;
    if (typeof msg === "string") return msg;
    if (msg && typeof msg === "object") return JSON.stringify(msg);
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

export function StellarWalletPicker({
  open,
  network,
  onClose,
  onConnected,
}: {
  open: boolean;
  network: StellarNetwork;
  onClose: () => void;
  onConnected: (address: string, walletId: string) => void;
}) {
  const [wallets, setWallets] = useState<ISupportedWallet[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setWallets(null);
    listAvailableWallets(network)
      .then((list) => setWallets(list))
      .catch((e) => setError(stringifyErr(e)));
  }, [open, network]);

  const handlePick = async (w: ISupportedWallet) => {
    setBusy(w.id);
    setError(null);
    try {
      const { address } = await selectWallet(network, w.id);
      onConnected(address, w.id);
      onClose();
    } catch (e) {
      setError(stringifyErr(e));
    } finally {
      setBusy(null);
    }
  };

  // Sort: available + bridge wallets first (WC), then installed, then rest
  const sorted = (wallets ?? []).slice().sort((a, b) => {
    const score = (w: ISupportedWallet) =>
      (w.isAvailable ? 2 : 0) + (w.type === "BRIDGE_WALLET" ? 1 : 0);
    return score(b) - score(a);
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connect Stellar wallet"
      subtitle={`${network === "mainnet" ? "Mainnet" : "Testnet"} · pick provider`}
      size="md"
    >
      <div className="divide-y divide-border">
        {!wallets && !error ? (
          <div className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading wallets…
          </div>
        ) : null}
        {error ? (
          <div className="border-b-2 border-destructive bg-destructive px-5 py-3 text-sm text-destructive-foreground">
            {error}
          </div>
        ) : null}
        {sorted.map((w) => {
          const isBusy = busy === w.id;
          const installed = w.isAvailable;
          const isBridge = w.type === "BRIDGE_WALLET";
          return (
            <button
              key={w.id}
              type="button"
              disabled={!installed && !isBridge}
              onClick={() => handlePick(w)}
              className={cn(
                "flex w-full items-center gap-3 px-5 py-3 text-left transition-colors",
                installed || isBridge
                  ? "hover:bg-accent"
                  : "cursor-not-allowed opacity-40",
              )}
            >
              <div className="grid size-9 shrink-0 place-items-center border border-border-strong bg-card-elevated">
                {w.icon ? (
                  <img
                    src={w.icon}
                    alt=""
                    className="size-6 object-contain"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display =
                        "none";
                    }}
                  />
                ) : (
                  <Wallet className="size-4 text-muted-foreground" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold uppercase tracking-wide">
                  {w.name}
                </div>
                <div className="font-mono text-[10px] text-muted-foreground">
                  {isBridge
                    ? "WalletConnect · multi-device"
                    : installed
                      ? "Installed"
                      : "Not installed"}
                </div>
              </div>
              {isBusy ? (
                <Loader2 className="size-4 animate-spin text-foreground" />
              ) : (installed || isBridge) ? (
                <span className="border border-border-strong bg-card-elevated px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
                  Connect
                </span>
              ) : (
                <a
                  href={w.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="border border-border-strong bg-card-elevated px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider hover:bg-foreground hover:text-background"
                >
                  Install
                </a>
              )}
            </button>
          );
        })}
        {sorted.length === 0 && !error && wallets ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            No wallets detected. Install Freighter, LOBSTR, or xBull.
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

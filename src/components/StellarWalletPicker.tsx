import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, Loader2, Wallet } from "lucide-react";
import type { ISupportedWallet } from "@creit.tech/stellar-wallets-kit";
import { LEDGER_ID } from "@creit.tech/stellar-wallets-kit/modules/ledger";
import { Modal } from "./Modal";
import {
  listAvailableWallets,
  listLedgerAccounts,
  selectLedgerAccount,
  selectWallet,
  type LedgerAccountOption,
} from "@/lib/wallet";
import type { StellarNetwork } from "@/lib/cctp";
import { cn, formatError as stringifyErr, shortAddr } from "@/lib/utils";

type View = "wallets" | "ledger-accounts";

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
  const [view, setView] = useState<View>("wallets");
  const [wallets, setWallets] = useState<ISupportedWallet[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Ledger sub-view state
  const [ledgerAccounts, setLedgerAccounts] = useState<LedgerAccountOption[] | null>(null);
  const [ledgerBusy, setLedgerBusy] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setView("wallets");
    setError(null);
    setWallets(null);
    setLedgerAccounts(null);
    listAvailableWallets(network)
      .then((list) => setWallets(list))
      .catch((e) => setError(stringifyErr(e)));
  }, [open, network]);

  const openLedgerAccountView = async () => {
    setView("ledger-accounts");
    setError(null);
    setLedgerAccounts(null);
    try {
      const list = await listLedgerAccounts(5);
      setLedgerAccounts(list);
    } catch (e) {
      setError(stringifyErr(e));
    }
  };

  const handlePick = async (w: ISupportedWallet) => {
    if (w.id === LEDGER_ID) {
      await openLedgerAccountView();
      return;
    }
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

  const handlePickLedgerIndex = async (idx: number) => {
    setLedgerBusy(idx);
    setError(null);
    try {
      const { address } = await selectLedgerAccount(network, idx);
      onConnected(address, LEDGER_ID);
      onClose();
    } catch (e) {
      setError(stringifyErr(e));
    } finally {
      setLedgerBusy(null);
    }
  };

  // Sort: available + bridge wallets first (WC), then installed, then rest
  const sorted = (wallets ?? []).slice().sort((a, b) => {
    const score = (w: ISupportedWallet) =>
      (w.isAvailable ? 2 : 0) + (w.type === "BRIDGE_WALLET" ? 1 : 0);
    return score(b) - score(a);
  });

  const title = view === "ledger-accounts" ? "Choose Ledger account" : "Connect Stellar wallet";
  const subtitle =
    view === "ledger-accounts"
      ? "First 5 derivations · m/44'/148'/N'"
      : `${network === "mainnet" ? "Mainnet" : "Testnet"} · pick provider`;

  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={subtitle} size="md">
      {view === "ledger-accounts" ? (
        <div className="divide-y divide-border">
          <button
            type="button"
            onClick={() => {
              setView("wallets");
              setError(null);
            }}
            className="flex items-center gap-2 border-b border-border px-5 py-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="size-3" /> Back to wallets
          </button>
          {error ? (
            <div className="border-b-2 border-destructive bg-destructive px-5 py-3 text-sm text-destructive-foreground">
              {error}
            </div>
          ) : null}
          {!ledgerAccounts && !error ? (
            <div className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Reading accounts from Ledger…
              <span className="font-mono text-[10px]">approve each on device</span>
            </div>
          ) : null}
          {ledgerAccounts?.map((a) => {
            const busyNow = ledgerBusy === a.index;
            return (
              <button
                key={a.index}
                type="button"
                disabled={!!ledgerBusy && ledgerBusy !== a.index}
                onClick={() => handlePickLedgerIndex(a.index)}
                className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-accent disabled:opacity-40"
              >
                <div className="grid size-9 shrink-0 place-items-center border border-border-strong bg-card-elevated font-mono text-xs font-bold">
                  {a.index}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold uppercase tracking-wide">
                    Account {a.index}
                  </div>
                  <div className="break-all font-mono text-[11px] text-muted-foreground">
                    {a.address}
                  </div>
                  <div className="font-mono text-[9px] text-muted-foreground">
                    m/44'/148'/{a.index}'
                  </div>
                </div>
                {busyNow ? (
                  <Loader2 className="size-4 animate-spin text-foreground" />
                ) : (
                  <ChevronRight className="size-4 text-muted-foreground" />
                )}
              </button>
            );
          })}
        </div>
      ) : (
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
            const isLedger = w.id === LEDGER_ID;
            return (
              <button
                key={w.id}
                type="button"
                disabled={!installed && !isBridge && !isLedger}
                onClick={() => handlePick(w)}
                className={cn(
                  "flex w-full items-center gap-3 px-5 py-3 text-left transition-colors",
                  installed || isBridge || isLedger
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
                        (e.currentTarget as HTMLImageElement).style.display = "none";
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
                    {isLedger
                      ? "Hardware · pick account on next step"
                      : isBridge
                        ? "WalletConnect · multi-device"
                        : installed
                          ? "Installed"
                          : "Not installed"}
                  </div>
                </div>
                {isBusy ? (
                  <Loader2 className="size-4 animate-spin text-foreground" />
                ) : installed || isBridge || isLedger ? (
                  <span className="border border-border-strong bg-card-elevated px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
                    {isLedger ? "Choose" : "Connect"}
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
      )}
    </Modal>
  );
}

// avoid bundler stripping unused helper if added later
void shortAddr;

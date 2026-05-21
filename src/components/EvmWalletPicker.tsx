import { Loader2, Wallet } from "lucide-react";
import { Modal } from "./Modal";
import { cn } from "@/lib/utils";

export function EvmWalletPicker({
  open,
  onClose,
  onPickInjected,
  onPickWalletConnect,
  injectedAvailable,
  wcAvailable,
  connecting,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onPickInjected: () => void | Promise<void>;
  onPickWalletConnect: () => void | Promise<void>;
  injectedAvailable: boolean;
  wcAvailable: boolean;
  connecting: boolean;
  error: string | null;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connect EVM wallet"
      subtitle="MetaMask, Rabby, Coinbase, etc. or WalletConnect"
      size="md"
    >
      <div className="divide-y divide-border">
        {error ? (
          <div className="border-b-2 border-destructive bg-destructive px-5 py-3 text-sm text-destructive-foreground">
            {error}
          </div>
        ) : null}

        <PickerRow
          icon={<Wallet className="size-4 text-muted-foreground" />}
          name="Browser wallet"
          caption={injectedAvailable ? "Installed" : "Not detected"}
          enabled={injectedAvailable && !connecting}
          onClick={onPickInjected}
          installUrl={!injectedAvailable ? "https://metamask.io/download/" : undefined}
        />

        <PickerRow
          icon={<WcLogo />}
          name="WalletConnect"
          caption={wcAvailable ? "QR · multi-device" : "Disabled (no project ID)"}
          enabled={wcAvailable && !connecting}
          onClick={onPickWalletConnect}
        />

        {connecting ? (
          <div className="flex items-center gap-2 px-5 py-3 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Waiting for wallet…
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function PickerRow({
  icon,
  name,
  caption,
  enabled,
  onClick,
  installUrl,
}: {
  icon: React.ReactNode;
  name: string;
  caption: string;
  enabled: boolean;
  onClick: () => void | Promise<void>;
  installUrl?: string;
}) {
  return (
    <button
      type="button"
      disabled={!enabled && !installUrl}
      onClick={() => {
        if (enabled) onClick();
      }}
      className={cn(
        "flex w-full items-center gap-3 px-5 py-3 text-left transition-colors",
        enabled || installUrl ? "hover:bg-accent" : "cursor-not-allowed opacity-40",
      )}
    >
      <div className="grid size-9 shrink-0 place-items-center border border-border-strong bg-card-elevated">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold uppercase tracking-wide">{name}</div>
        <div className="font-mono text-[10px] text-muted-foreground">
          {caption}
        </div>
      </div>
      {installUrl ? (
        <a
          href={installUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="border border-border-strong bg-card-elevated px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider hover:bg-foreground hover:text-background"
        >
          Install
        </a>
      ) : (
        <span className="border border-border-strong bg-card-elevated px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
          Connect
        </span>
      )}
    </button>
  );
}

function WcLogo() {
  return (
    <svg viewBox="0 0 40 40" width={20} height={20} aria-label="WalletConnect">
      <path
        fill="#3B99FC"
        d="M11.4 14.5c4.7-4.6 12.4-4.6 17.2 0l.6.5c.2.2.2.6 0 .8l-1.9 1.9c-.1.1-.3.1-.4 0l-.8-.8c-3.3-3.2-8.6-3.2-11.9 0l-.9.8c-.1.1-.3.1-.4 0l-1.9-1.9c-.2-.2-.2-.6 0-.8l.4-.5zm21.3 4l1.7 1.7c.2.2.2.6 0 .8L26.8 28.7c-.2.2-.6.2-.8 0l-5.4-5.3c-.1-.1-.2-.1-.2 0L15 28.7c-.2.2-.6.2-.8 0L6.6 21c-.2-.2-.2-.6 0-.8l1.7-1.7c.2-.2.6-.2.8 0l5.4 5.3c.1.1.2.1.2 0L20 18.5c.2-.2.6-.2.8 0l5.3 5.3c.1.1.2.1.2 0l5.4-5.3c.3-.2.7-.2 1 0z"
      />
    </svg>
  );
}

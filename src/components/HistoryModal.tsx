import { useState } from "react";
import { ArrowUpRight, ExternalLink, Trash2 } from "lucide-react";
import { Modal } from "./Modal";
import { Badge } from "./ui/badge";
import { cn, shortAddr } from "@/lib/utils";
import { chainsFor, type ChainInfo } from "@/lib/cctp";
import type { HistoryEntry, HistoryPhase } from "@/lib/history";

export function HistoryModal({
  open,
  onClose,
  history,
  onRemove,
  onClear,
  onResume,
}: {
  open: boolean;
  onClose: () => void;
  history: HistoryEntry[];
  onRemove: (id: string) => void;
  onClear: () => void;
  onResume: (entry: HistoryEntry) => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Recent transfers"
      subtitle={`Last ${history.length || 0} of 5 · stored locally`}
      size="lg"
    >
      <div className="divide-y divide-border">
        {history.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-muted-foreground">No transfers yet.</p>
          </div>
        ) : null}
        {history.map((e) => (
          <Row key={e.id} entry={e} onRemove={onRemove} onResume={onResume} />
        ))}
        {history.length > 0 ? (
          <div className="flex items-center justify-between px-5 py-3">
            <span className="font-mono text-[10px] text-muted-foreground">
              Cleared on disconnect of all wallets · max 5 entries
            </span>
            <button
              type="button"
              onClick={onClear}
              className="flex items-center gap-1 border border-border-strong bg-card-elevated px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
            >
              <Trash2 className="size-3" />
              Clear all
            </button>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function phaseBadge(phase: HistoryPhase) {
  if (phase === "done") return <Badge variant="success">Completed</Badge>;
  if (phase === "error") return <Badge variant="destructive">Failed</Badge>;
  if (phase === "idle")
    return (
      <Badge variant="outline" className="font-mono text-[10px]">
        Idle
      </Badge>
    );
  return (
    <Badge variant="outline" className="font-mono text-[10px]">
      {phase}
    </Badge>
  );
}

function Row({
  entry,
  onRemove,
  onResume,
}: {
  entry: HistoryEntry;
  onRemove: (id: string) => void;
  onResume: (entry: HistoryEntry) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const fromChain = lookupChain(entry.fromChainId, entry.network);
  const toChain = lookupChain(entry.toChainId, entry.network);
  // Resume is meaningful only when burn happened + mint hasn't landed.
  const canResume = !!entry.attestationMessage && !entry.mintTx;
  return (
    <div className="px-5 py-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-3 text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs">
            <span className="eyebrow">
              {fromChain?.shortName ?? entry.fromChainId} → {toChain?.shortName ?? entry.toChainId}
            </span>
            {phaseBadge(entry.phase)}
            <span className="font-mono text-[10px] text-muted-foreground">
              {fmtDate(entry.createdAt)}
            </span>
          </div>
          <div className="mt-1 font-mono text-sm">
            <span className="font-bold">{entry.sendAmount}</span>
            <span className="text-muted-foreground"> USDC → </span>
            <span className="font-bold">{entry.receiveAmount}</span>
            <span className="text-muted-foreground"> USDC</span>
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            to {shortAddr(entry.recipient, 6, 6)} · {entry.network}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          {canResume ? (
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation();
                onResume(entry);
              }}
              className="flex items-center gap-1 border-2 border-foreground bg-primary px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-primary-foreground hover:bg-foreground hover:text-background"
            >
              <ArrowUpRight className="size-3" />
              Resume
            </button>
          ) : null}
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation();
              onRemove(entry.id);
            }}
            className="flex items-center gap-1 border border-border-strong bg-card-elevated px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
          >
            <Trash2 className="size-3" />
          </button>
        </div>
      </button>

      {expanded ? (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {entry.approveTx ? (
            <ExplorerLine
              label={`Approve · ${fromChain?.name ?? entry.fromChainId}`}
              hash={entry.approveTx}
              url={fromChain?.explorerTxUrl(entry.approveTx)}
            />
          ) : null}
          {entry.burnTx ? (
            <ExplorerLine
              label={`Burn · ${fromChain?.name ?? entry.fromChainId}`}
              hash={entry.burnTx}
              url={fromChain?.explorerTxUrl(entry.burnTx)}
            />
          ) : null}
          {entry.mintTx ? (
            <ExplorerLine
              label={`Mint · ${toChain?.name ?? entry.toChainId}`}
              hash={entry.mintTx}
              url={toChain?.explorerTxUrl(entry.mintTx)}
            />
          ) : null}
          <Field label="Sender" value={entry.sender} />
          <Field label="Recipient" value={entry.recipient} />
          <Field label="Speed" value={entry.speed} />
          <Field label="Updated" value={fmtDate(entry.updatedAt)} />
          {entry.error ? (
            <Field label="Error" value={entry.error} variant="destructive" />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ExplorerLine({
  label,
  hash,
  url,
}: {
  label: string;
  hash: string;
  url?: string;
}) {
  return (
    <a
      href={url ?? "#"}
      target="_blank"
      rel="noreferrer"
      className="flex items-center justify-between border border-border-strong bg-card-elevated px-3 py-1.5 text-xs hover:bg-accent"
    >
      <div>
        <div className="eyebrow">{label}</div>
        <div className="font-mono text-[11px]">{shortAddr(hash, 10, 8)}</div>
      </div>
      <ExternalLink className="size-3 text-muted-foreground" />
    </a>
  );
}

function Field({
  label,
  value,
  variant,
}: {
  label: string;
  value: string;
  variant?: "destructive";
}) {
  return (
    <div className="grid grid-cols-[80px_1fr] items-start gap-2 text-[11px]">
      <span className="eyebrow">{label}</span>
      <span
        className={cn(
          "break-all font-mono",
          variant === "destructive" ? "text-destructive" : "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    year: "2-digit",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function lookupChain(id: string, network: "mainnet" | "testnet"): ChainInfo | undefined {
  return chainsFor(network).find((c) => c.id === id);
}

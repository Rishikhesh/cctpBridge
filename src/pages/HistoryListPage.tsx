import { useNavigate } from "react-router-dom";
import { ArrowRight, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { chainsFor, type ChainInfo } from "@/lib/cctp";
import type { HistoryEntry, HistoryPhase } from "@/lib/history";
import { shortAddr } from "@/lib/utils";

export function HistoryListPage({
  entries,
  onRemove,
  onClear,
}: {
  entries: HistoryEntry[];
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const nav = useNavigate();
  return (
    <div className="mx-auto max-w-5xl px-5 py-6">
      <div className="mb-4 flex items-baseline justify-between border-b-2 border-border-strong pb-3">
        <h1 className="font-display text-3xl leading-none">
          Recent <span className="italic">transfers.</span>
        </h1>
        <span className="font-mono text-[10px] text-muted-foreground">
          {entries.length}/5 stored locally
        </span>
      </div>

      {entries.length === 0 ? (
        <div className="border border-dashed border-border-strong bg-card p-10 text-center">
          <p className="text-sm text-muted-foreground">
            No transfers yet. Initiate one from the Bridge page.
          </p>
          <button
            type="button"
            onClick={() => nav("/")}
            className="mt-4 inline-flex items-center gap-1 border-2 border-foreground bg-primary px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-primary-foreground hover:bg-foreground hover:text-background"
          >
            Go to Bridge <ArrowRight className="size-3" />
          </button>
        </div>
      ) : null}

      <div className="divide-y divide-border border border-border-strong bg-card">
        {entries.map((e) => {
          const fromChain = lookupChain(e.fromChainId, e.network);
          const toChain = lookupChain(e.toChainId, e.network);
          return (
            <button
              key={e.id}
              type="button"
              onClick={() => nav(`/history/${e.id}`)}
              className="flex w-full items-center gap-4 px-5 py-3 text-left hover:bg-accent"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="eyebrow">
                    {fromChain?.shortName ?? e.fromChainId} →{" "}
                    {toChain?.shortName ?? e.toChainId}
                  </span>
                  {phaseBadge(e.phase)}
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {fmtDate(e.createdAt)}
                  </span>
                </div>
                <div className="mt-1 font-mono text-sm">
                  <span className="font-bold">{e.sendAmount}</span>
                  <span className="text-muted-foreground"> USDC → </span>
                  <span className="font-bold">{e.receiveAmount}</span>
                  <span className="text-muted-foreground"> USDC</span>
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  to {shortAddr(e.recipient, 6, 6)} · {e.network}
                </div>
              </div>
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onRemove(e.id);
                }}
                className="border border-border-strong bg-card-elevated p-1.5 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
                title="Delete"
              >
                <Trash2 className="size-3" />
              </button>
            </button>
          );
        })}
      </div>

      {entries.length > 0 ? (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClear}
            className="flex items-center gap-1 border border-border-strong bg-card-elevated px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
          >
            <Trash2 className="size-3" /> Clear all
          </button>
        </div>
      ) : null}
    </div>
  );
}

function phaseBadge(phase: HistoryPhase) {
  if (phase === "done") return <Badge variant="success">Completed</Badge>;
  if (phase === "error") return <Badge variant="destructive">Failed</Badge>;
  return (
    <Badge variant="outline" className="font-mono text-[10px]">
      {phase}
    </Badge>
  );
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
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

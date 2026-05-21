import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  ExternalLink,
  Loader2,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { StatusTimeline, type TimelineStep } from "@/components/StatusTimeline";
import { chainsFor, type ChainInfo } from "@/lib/cctp";
import type { HistoryEntry } from "@/lib/history";
import { cn, shortAddr } from "@/lib/utils";

export type RetryStep = "approve" | "burn" | "attest" | "mint";

export function HistoryDetailPage({
  entries,
  onRemove,
  onRetryFromStep,
  retryingStep,
}: {
  entries: HistoryEntry[];
  onRemove: (id: string) => void;
  onRetryFromStep: (entry: HistoryEntry, step: RetryStep) => void;
  retryingStep: RetryStep | null;
}) {
  // We render this page conditionally (not via <Route path="/history/:id">),
  // so useParams() is empty. Parse the id directly from the pathname.
  const loc = useLocation();
  const id = loc.pathname.replace(/^\/history\//, "") || undefined;
  const nav = useNavigate();
  const entry = entries.find((e) => e.id === id);

  if (!entry) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-10">
        <button
          type="button"
          onClick={() => nav("/history")}
          className="mb-4 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3" /> Back
        </button>
        <Alert>
          <AlertTitle>Entry not found</AlertTitle>
          <AlertDescription>
            That transfer is no longer in the local history (max 5 entries).
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const fromChain = lookupChain(entry.fromChainId, entry.network);
  const toChain = lookupChain(entry.toChainId, entry.network);

  return (
    <div className="mx-auto max-w-3xl px-5 py-6">
      <button
        type="button"
        onClick={() => nav("/history")}
        className="mb-4 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3" /> Back to history
      </button>

      <div className="mb-4 border-b-2 border-border-strong pb-3">
        <div className="flex items-baseline justify-between">
          <h1 className="font-display text-3xl leading-none">
            {fromChain?.name ?? entry.fromChainId} →{" "}
            <span className="italic">{toChain?.name ?? entry.toChainId}</span>
          </h1>
          <PhaseBadge entry={entry} />
        </div>
        <p className="mt-2 font-mono text-[11px] text-muted-foreground">
          {fmtDate(entry.createdAt)} · {entry.network} · {entry.speed}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 border border-border-strong bg-card p-4">
        <div>
          <div className="eyebrow">Send · {fromChain?.shortName ?? entry.fromChainId}</div>
          <div className="mt-1 font-mono text-xl font-bold">
            {entry.sendAmount} <span className="text-muted-foreground">USDC</span>
          </div>
        </div>
        <div className="text-right">
          <div className="eyebrow">Receive · {toChain?.shortName ?? entry.toChainId}</div>
          <div className="mt-1 font-mono text-xl font-bold">
            {entry.receiveAmount} <span className="text-muted-foreground">USDC</span>
          </div>
        </div>
      </div>

      <Section title="Timeline">
        <StepTimeline
          entry={entry}
          fromChain={fromChain}
          toChain={toChain}
          onRetryFromStep={(s) => onRetryFromStep(entry, s)}
          retryingStep={retryingStep}
        />
      </Section>

      {entry.error ? (
        <Section title="Error">
          <Alert variant="destructive">
            <AlertDescription className="break-words font-mono text-xs">
              {entry.error}
            </AlertDescription>
          </Alert>
        </Section>
      ) : null}

      <Section title="Parties">
        <FieldRow label="Sender" value={entry.sender} />
        <FieldRow label="Recipient" value={entry.recipient} />
      </Section>

      <Section title="Actions">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              onRemove(entry.id);
              nav("/history");
            }}
            className="flex items-center gap-1 border border-border-strong bg-card-elevated px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
          >
            <Trash2 className="size-3" /> Delete entry
          </button>
        </div>
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-5">
      <div className="mb-2 border-b border-border-strong pb-1">
        <span className="eyebrow">{title}</span>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };
  return (
    <div className="grid grid-cols-[80px_1fr_auto] items-center gap-3 border border-border-strong bg-card-elevated px-3 py-2 text-xs">
      <span className="eyebrow">{label}</span>
      <span className="break-all font-mono">{value}</span>
      <button
        type="button"
        onClick={copy}
        className="border border-border-strong bg-card px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider hover:bg-foreground hover:text-background"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function PhaseBadge({ entry }: { entry: HistoryEntry }) {
  if (entry.phase === "done") return <Badge variant="success">Completed</Badge>;
  if (entry.phase === "error") return <Badge variant="destructive">Failed</Badge>;
  return (
    <Badge variant="outline" className="font-mono text-[10px]">
      {entry.phase}
    </Badge>
  );
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

function lookupChain(id: string, network: "mainnet" | "testnet"): ChainInfo | undefined {
  return chainsFor(network).find((c) => c.id === id);
}

function StepTimeline({
  entry,
  fromChain,
  toChain,
  onRetryFromStep,
  retryingStep,
}: {
  entry: HistoryEntry;
  fromChain?: ChainInfo;
  toChain?: ChainInfo;
  onRetryFromStep: (s: RetryStep) => void;
  retryingStep: RetryStep | null;
}) {
  // Compute step states from entry data.
  const steps = useMemo(() => {
    const isEvmSource =
      entry.direction === "evm->evm" ||
      entry.direction === "evm->stellar" ||
      entry.direction === "evm->solana";

    const stepDefs: {
      key: RetryStep;
      label: string;
      txHash?: string;
      txUrl?: string;
      done: boolean;
      isFailureStep: boolean;
    }[] = [];

    // Approve step — only meaningful when source is EVM AND we actually
    // submitted one (we may skip approve if allowance was already set).
    if (isEvmSource) {
      stepDefs.push({
        key: "approve",
        label: `Approve USDC on ${fromChain?.name ?? entry.fromChainId}`,
        txHash: entry.approveTx,
        txUrl: entry.approveTx && fromChain ? fromChain.explorerTxUrl(entry.approveTx) : undefined,
        done: !!entry.approveTx || !!entry.burnTx, // burn implies approve already passed
        isFailureStep: !entry.approveTx && !entry.burnTx && entry.phase === "error",
      });
    } else {
      stepDefs.push({
        key: "approve",
        label: `Approve USDC on ${fromChain?.name ?? entry.fromChainId}`,
        txHash: entry.approveTx,
        txUrl: entry.approveTx && fromChain ? fromChain.explorerTxUrl(entry.approveTx) : undefined,
        done: !!entry.approveTx || !!entry.burnTx,
        isFailureStep: !entry.approveTx && !entry.burnTx && entry.phase === "error",
      });
    }

    stepDefs.push({
      key: "burn",
      label: `Burn on ${fromChain?.name ?? entry.fromChainId}`,
      txHash: entry.burnTx,
      txUrl: entry.burnTx && fromChain ? fromChain.explorerTxUrl(entry.burnTx) : undefined,
      done: !!entry.burnTx,
      isFailureStep: !entry.burnTx && entry.approveTx !== undefined && entry.phase === "error",
    });

    stepDefs.push({
      key: "attest",
      label: "Circle attestation",
      done: !!entry.attestationMessage,
      isFailureStep:
        !!entry.burnTx && !entry.attestationMessage && entry.phase === "error",
    });

    stepDefs.push({
      key: "mint",
      label: `Mint on ${toChain?.name ?? entry.toChainId}`,
      txHash: entry.mintTx,
      txUrl: entry.mintTx && toChain ? toChain.explorerTxUrl(entry.mintTx) : undefined,
      done: !!entry.mintTx && entry.phase === "done",
      isFailureStep:
        !!entry.attestationMessage && !entry.mintTx && entry.phase === "error",
    });

    return stepDefs;
  }, [entry, fromChain, toChain]);

  // Find the first not-done step — that's the resumable starting point.
  const firstPendingIdx = steps.findIndex((s) => !s.done);

  const timelineSteps: TimelineStep[] = steps.map((s, i) => ({
    key: s.key,
    label: s.label,
    state: s.done
      ? "done"
      : s.isFailureStep
        ? "error"
        : i === firstPendingIdx
          ? "active"
          : "pending",
    hint: s.txHash ? shortAddr(s.txHash, 10, 8) : undefined,
  }));

  return (
    <div className="space-y-3 border border-border-strong bg-card p-4">
      <StatusTimeline steps={timelineSteps} />

      {/* Explorer links */}
      <div className="space-y-1">
        {steps
          .filter((s) => s.txHash && s.txUrl)
          .map((s) => (
            <a
              key={s.key}
              href={s.txUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between border border-border bg-card-elevated px-3 py-1.5 text-xs hover:bg-accent"
            >
              <span className="eyebrow">{s.key}</span>
              <span className="font-mono">{shortAddr(s.txHash!, 10, 8)}</span>
              <ExternalLink className="size-3 text-muted-foreground" />
            </a>
          ))}
      </div>

      {/* Retry buttons — only when entry is failed and we know which step to resume */}
      {entry.phase === "error" && firstPendingIdx >= 0 ? (
        <div className="border-t border-border pt-3">
          <div className="eyebrow mb-2">Retry options</div>
          <div className="flex flex-wrap gap-2">
            {steps.slice(firstPendingIdx).map((s) => {
              // Skip steps that aren't actually retryable (e.g. attest after burn missing)
              if (s.key === "attest" && !entry.burnTx) return null;
              if (s.key === "mint" && !entry.attestationMessage) return null;
              const busy = retryingStep === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  disabled={!!retryingStep}
                  onClick={() => onRetryFromStep(s.key)}
                  className={cn(
                    "flex items-center gap-1.5 border-2 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-colors disabled:opacity-50",
                    s.key === "mint" || s.key === firstStep(firstPendingIdx, steps)
                      ? "border-foreground bg-primary text-primary-foreground hover:bg-foreground hover:text-background"
                      : "border-border-strong bg-card-elevated text-foreground hover:bg-foreground hover:text-background",
                  )}
                >
                  {busy ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <ArrowUpRight className="size-3.5" />
                  )}
                  Retry from {s.key}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">
            CCTP burns are irreversible and nonces are single-use — retrying a step
            that already landed will be rejected on-chain. Start from the failed
            step.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function firstStep(idx: number, steps: { key: RetryStep }[]): RetryStep {
  return steps[idx]?.key ?? "approve";
}

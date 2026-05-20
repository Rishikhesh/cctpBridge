import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChainInfo } from "@/lib/cctp";
import { ChainLogo, UsdcLogo } from "./ChainLogo";

export function ChainPicker({
  chains,
  value,
  onChange,
  disabled,
  label = "Chain",
  filterUnsupported,
}: {
  chains: ChainInfo[];
  value: ChainInfo;
  onChange: (c: ChainInfo) => void;
  disabled?: boolean;
  label?: string;
  filterUnsupported?: (c: ChainInfo) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chains;
    return chains.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.shortName.toLowerCase().includes(q) ||
        String(c.domainId) === q,
    );
  }, [chains, query]);

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={cn(
          "group flex items-center gap-2 border border-border-strong bg-card-elevated px-2.5 py-1.5 transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60",
        )}
        aria-label={`Select ${label}`}
      >
        <ChainLogo chain={value} size={22} />
        <span className="text-sm font-semibold uppercase tracking-wide">
          {value.name}
        </span>
        <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-hover:text-foreground" />
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 pt-20 backdrop-blur-sm sm:items-start"
            role="dialog"
            aria-modal="true"
            onClick={() => setOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <motion.div
              className="w-full max-w-md border-2 border-foreground bg-card"
              onClick={(e) => e.stopPropagation()}
              initial={{ y: 16, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 16, opacity: 0 }}
              transition={{ type: "spring", stiffness: 360, damping: 28 }}
            >
              <div className="flex items-center justify-between border-b-2 border-foreground px-5 py-3">
                <h3 className="font-display text-2xl leading-none">
                  Select <span className="italic">{label.toLowerCase()}</span>
                </h3>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="border border-border-strong p-1 text-muted-foreground hover:bg-foreground hover:text-background"
                  aria-label="Close"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="border-b border-border-strong px-4 py-3">
                <div className="flex items-center gap-2 border border-border-strong bg-card-elevated px-3">
                  <Search className="size-4 text-muted-foreground" />
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search chain or domain"
                    className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  />
                </div>
              </div>
              <div className="max-h-[440px] overflow-y-auto">
                {filtered.length === 0 ? (
                  <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No chains match "{query}".
                  </div>
                ) : null}
                {filtered.map((c) => {
                  const unsupported = filterUnsupported ? !filterUnsupported(c) : false;
                  const active = c.id === value.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      disabled={unsupported}
                      onClick={() => {
                        onChange(c);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0",
                        active ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                        unsupported && "cursor-not-allowed opacity-40",
                      )}
                    >
                      <ChainLogo chain={c} size={28} />
                      <div className="flex-1">
                        <div className="text-sm font-bold uppercase tracking-wide">
                          {c.name}
                        </div>
                        <div className={cn("font-mono text-[10px]", active ? "text-primary-foreground/70" : "text-muted-foreground")}>
                          {c.kind} · domain {c.domainId}
                        </div>
                      </div>
                      {unsupported ? (
                        <span className="border border-border-strong px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                          soon
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

export function TokenChip({
  symbol,
  className,
  onClick,
}: {
  symbol: string;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        "flex shrink-0 items-center gap-2 border border-border-strong bg-card-elevated px-2 py-1.5 transition-colors enabled:hover:bg-accent",
        className,
      )}
    >
      <UsdcLogo size={20} />
      <span className="pr-1 text-sm font-bold uppercase tracking-wide">
        {symbol}
      </span>
    </button>
  );
}

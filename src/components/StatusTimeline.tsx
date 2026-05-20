import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type StepState = "pending" | "active" | "done" | "error";

export interface TimelineStep {
  key: string;
  label: string;
  state: StepState;
  hint?: string;
}

export function StatusTimeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((step, i) => (
        <li key={step.key} className="flex items-start gap-3">
          <div
            className={cn(
              "mt-0.5 flex size-6 shrink-0 items-center justify-center border text-xs font-bold",
              step.state === "done" &&
                "border-foreground bg-foreground text-background",
              step.state === "active" &&
                "border-foreground bg-accent text-accent-ink",
              step.state === "pending" &&
                "border-border-strong/40 bg-transparent text-muted-foreground",
              step.state === "error" &&
                "border-foreground bg-destructive text-destructive-foreground",
            )}
          >
            {step.state === "done" && <Check className="size-3.5" />}
            {step.state === "active" && (
              <Loader2 className="size-3.5 animate-spin" />
            )}
            {step.state === "pending" && (
              <span className="font-mono text-[10px]">
                {String(i + 1).padStart(2, "0")}
              </span>
            )}
            {step.state === "error" && <span>!</span>}
          </div>
          <div className="flex-1">
            <div
              className={cn(
                "text-sm font-medium uppercase tracking-wide",
                step.state === "pending" && "text-muted-foreground",
              )}
            >
              {step.label}
            </div>
            {step.hint ? (
              <div className="break-all font-mono text-[11px] text-muted-foreground">
                {step.hint}
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

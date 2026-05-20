import * as React from "react";
import { cn } from "@/lib/utils";

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "inline-block animate-pulse border border-border-strong/40 bg-foreground/10",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };

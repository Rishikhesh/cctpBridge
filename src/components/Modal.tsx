import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  const widthClass =
    size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-lg" : "max-w-md";

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
          aria-modal
          role="dialog"
        >
          <motion.div
            className={cn(
              "relative w-full border-2 border-foreground bg-card text-card-foreground",
              widthClass,
            )}
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
          >
            {(title || subtitle) ? (
              <div className="flex items-start justify-between gap-3 border-b-2 border-foreground px-5 py-3">
                <div className="min-w-0">
                  {title ? (
                    <div className="font-display text-2xl leading-none">
                      {title}
                    </div>
                  ) : null}
                  {subtitle ? (
                    <div className="eyebrow mt-1">{subtitle}</div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="border border-border-strong p-1 text-muted-foreground hover:bg-foreground hover:text-background"
                  aria-label="Close"
                >
                  <X className="size-4" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="absolute right-3 top-3 z-10 border border-border-strong bg-card-elevated p-1 text-muted-foreground hover:bg-foreground hover:text-background"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            )}
            <div className="max-h-[80vh] overflow-y-auto">{children}</div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

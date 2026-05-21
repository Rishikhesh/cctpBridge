import { useCallback, useEffect, useState } from "react";
import {
  clearHistory,
  loadHistory,
  removeHistory,
  upsertHistory,
  type HistoryEntry,
} from "@/lib/history";

export function useTxHistory() {
  const [list, setList] = useState<HistoryEntry[]>(() => loadHistory());

  // Pick up history changes from other tabs.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "cctp:txHistory") setList(loadHistory());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const upsert = useCallback((entry: HistoryEntry) => {
    setList(upsertHistory(entry));
  }, []);

  const remove = useCallback((id: string) => {
    setList(removeHistory(id));
  }, []);

  const clear = useCallback(() => {
    clearHistory();
    setList([]);
  }, []);

  return { list, upsert, remove, clear };
}

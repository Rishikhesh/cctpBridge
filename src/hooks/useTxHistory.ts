import { useCallback, useEffect, useMemo, useState } from "react";
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

  // MUST memoize the return object so consumers can safely add the hook
  // result to a useEffect dep array without re-firing every render. Each
  // inner ref (upsert/remove/clear) is already stable via useCallback;
  // `list` only changes on real mutation.
  return useMemo(
    () => ({ list, upsert, remove, clear }),
    [list, upsert, remove, clear],
  );
}

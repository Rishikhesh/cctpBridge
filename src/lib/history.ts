/**
 * Last-N transfer history persisted to localStorage. Lets users:
 *   - View recent transfers with status, timestamps, txs
 *   - Recover after page reload — burn tx + Circle attestation are the
 *     irrecoverable pieces; if we have them in history we can re-trigger
 *     the mint step without re-burning.
 */
export type HistoryDirection =
  | "stellar->evm"
  | "evm->stellar"
  | "evm->evm"
  | "evm->solana";

export type HistoryPhase =
  | "idle"
  | "approving"
  | "burning"
  | "attesting"
  | "minting"
  | "done"
  | "error";

/**
 * Minimal entry — chain names/shorts derived at render time from chainsFor()
 * to avoid duplicating ~40 bytes per entry. Attestation hex (often ~700 B
 * combined) is dropped on successful mint since it's no longer recoverable
 * data. Result: ~150–250 B per completed entry, ~900 B per in-flight one.
 */
export interface HistoryEntry {
  id: string;
  createdAt: number;
  updatedAt: number;
  direction: HistoryDirection;
  fromChainId: string;
  toChainId: string;
  network: "mainnet" | "testnet";
  sendAmount: string;       // human-readable
  receiveAmount: string;    // human-readable
  recipient: string;
  sender: string;
  speed: "fast" | "standard";
  phase: HistoryPhase;
  approveTx?: string;
  burnTx?: string;
  mintTx?: string;
  /** Stripped once mint succeeds — only kept while mint is pending/failed. */
  attestationMessage?: string;
  attestationHex?: string;
  /** Stripped on success to keep history terse. */
  error?: string;
}

const KEY = "cctp:txHistory";
const MAX = 5;

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isHistoryEntry).slice(0, MAX);
  } catch {
    return [];
  }
}

function isHistoryEntry(v: unknown): v is HistoryEntry {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.createdAt === "number" &&
    typeof o.direction === "string"
  );
}

export function saveHistory(list: HistoryEntry[]): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(list.slice(0, MAX).sort((a, b) => b.createdAt - a.createdAt)),
    );
  } catch {
    // ignore quota / private mode
  }
}

export function upsertHistory(entry: HistoryEntry): HistoryEntry[] {
  const list = loadHistory();
  const idx = list.findIndex((e) => e.id === entry.id);
  const next: HistoryEntry =
    idx >= 0
      ? { ...list[idx], ...entry, updatedAt: Date.now() }
      : { ...entry, updatedAt: Date.now() };

  // Trim heavy fields once a transfer settles successfully — attestation hex
  // can't be replayed after mint, error is irrelevant for "done".
  if (next.phase === "done" && next.mintTx) {
    delete next.attestationMessage;
    delete next.attestationHex;
    delete next.error;
  }

  if (idx >= 0) list[idx] = next;
  else list.unshift(next);
  const trimmed = list.slice(0, MAX);
  saveHistory(trimmed);
  return trimmed;
}

export function removeHistory(id: string): HistoryEntry[] {
  const list = loadHistory().filter((e) => e.id !== id);
  saveHistory(list);
  return list;
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

export function newHistoryId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

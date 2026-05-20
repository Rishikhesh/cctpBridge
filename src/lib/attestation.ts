export interface CctpAttestation {
  status: string;
  message: string;
  attestation: string;
  eventNonce?: string;
  cctpVersion?: number;
  decodedMessage?: unknown;
}

export interface AttestationStatusUpdate {
  attempt: number;
  status?: string;            // raw Iris status (pending_confirmations | complete | ...)
  finalityThresholdExecuted?: number;
  feeExecuted?: string;       // 6-dec subunits, decoded if available
}

// Approximate ETAs sourced from Circle published required block confirmations.
// Keys: source domain. Values: seconds.
export const CCTP_FINALITY_ETA_SECONDS: Record<number, { fast: number; standard: number }> = {
  0: { fast: 8, standard: 19 * 60 },      // Ethereum
  1: { fast: 8, standard: 60 },           // Avalanche
  2: { fast: 8, standard: 19 * 60 },      // OP
  3: { fast: 8, standard: 13 * 60 },      // Arbitrum
  5: { fast: 8, standard: 25 },           // Solana
  6: { fast: 8, standard: 19 * 60 },      // Base
  7: { fast: 8, standard: 8 * 60 },       // Polygon
  10: { fast: 8, standard: 19 * 60 },     // Unichain
  11: { fast: 8, standard: 19 * 60 },     // Linea
  13: { fast: 8, standard: 60 },          // Sonic
  14: { fast: 8, standard: 19 * 60 },     // World Chain
  17: { fast: 8, standard: 90 },          // BNB
  27: { fast: 8, standard: 10 },          // Stellar (near-instant finality)
};

export function cctpEtaSeconds(
  sourceDomain: number,
  finalityThreshold: number,
): number {
  const eta = CCTP_FINALITY_ETA_SECONDS[sourceDomain];
  if (!eta) return finalityThreshold >= 2000 ? 13 * 60 : 8;
  return finalityThreshold >= 2000 ? eta.standard : eta.fast;
}

export interface BurnFee {
  finalityThreshold: number;
  minimumFee: number;
}

interface IrisFeeEntry {
  finalityThreshold: number;
  minimumFee: number;
}

interface IrisMessageEntry {
  status: string;
  message: string;
  attestation: string;
  eventNonce?: string;
  cctpVersion?: number;
  decodedMessage?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseFeeEntries(data: unknown): IrisFeeEntry[] {
  const arr = isRecord(data) && Array.isArray(data.data) ? data.data : data;
  if (!Array.isArray(arr)) return [];
  const out: IrisFeeEntry[] = [];
  for (const item of arr) {
    if (!isRecord(item)) continue;
    const ft = item.finalityThreshold;
    const mf = item.minimumFee;
    if (typeof ft === "number" && typeof mf === "number") {
      out.push({ finalityThreshold: ft, minimumFee: mf });
    }
  }
  return out;
}

export async function fetchBurnFees(
  irisApiUrl: string,
  sourceDomain: number,
  destDomain: number,
  signal?: AbortSignal,
): Promise<{ fast: BurnFee; slow: BurnFee }> {
  const url = `${irisApiUrl}/v2/burn/usdc/fees/${sourceDomain}/${destDomain}`;
  // Use no-store cache mode so browser DevTools always shows the request.
  console.log("[CCTP] GET", url);
  const res = await fetch(url, { signal, cache: "no-store" });
  let entries: IrisFeeEntry[] = [];
  if (res.ok) {
    const body: unknown = await res.json();
    entries = parseFeeEntries(body);
    console.log("[CCTP] burn fees", { sourceDomain, destDomain, entries });
  } else {
    console.warn("[CCTP] burn fees fetch non-OK", res.status, res.statusText);
  }
  const fast =
    entries.find((e) => e.finalityThreshold === 1000) ??
    ({ finalityThreshold: 1000, minimumFee: 1 } as BurnFee);
  const slow =
    entries.find((e) => e.finalityThreshold === 2000) ??
    ({ finalityThreshold: 2000, minimumFee: 1 } as BurnFee);
  return { fast, slow };
}

function parseMessages(data: unknown): IrisMessageEntry[] {
  if (!isRecord(data)) return [];
  const messages = data.messages;
  if (!Array.isArray(messages)) return [];
  const out: IrisMessageEntry[] = [];
  for (const m of messages) {
    if (!isRecord(m)) continue;
    const status = m.status;
    const message = m.message;
    const attestation = m.attestation;
    if (typeof status !== "string") continue;
    const entry: IrisMessageEntry = {
      status,
      message: typeof message === "string" ? message : "",
      attestation: typeof attestation === "string" ? attestation : "",
    };
    if (typeof m.eventNonce === "string") entry.eventNonce = m.eventNonce;
    if (typeof m.cctpVersion === "number") entry.cctpVersion = m.cctpVersion;
    if (m.decodedMessage !== undefined) entry.decodedMessage = m.decodedMessage;
    out.push(entry);
  }
  return out;
}

function extractStatusMeta(
  m: IrisMessageEntry,
): { finalityThresholdExecuted?: number; feeExecuted?: string } {
  const meta: { finalityThresholdExecuted?: number; feeExecuted?: string } = {};
  const decoded = m.decodedMessage;
  if (!isRecord(decoded)) return meta;
  const ft = decoded.finalityThresholdExecuted;
  if (typeof ft === "string") meta.finalityThresholdExecuted = parseInt(ft, 10);
  if (typeof ft === "number") meta.finalityThresholdExecuted = ft;
  const body = decoded.decodedMessageBody;
  if (isRecord(body)) {
    const fee = body.feeExecuted;
    if (typeof fee === "string") meta.feeExecuted = fee;
  }
  return meta;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollAttestation(
  irisApiUrl: string,
  sourceDomain: number,
  txHash: string,
  opts?: {
    intervalMs?: number;
    signal?: AbortSignal;
    onPoll?: (update: AttestationStatusUpdate) => void;
  },
): Promise<CctpAttestation> {
  const intervalMs = opts?.intervalMs ?? 5000;
  const signal = opts?.signal;
  const url = `${irisApiUrl}/v2/messages/${sourceDomain}?transactionHash=${txHash}`;
  let attempt = 0;
  while (true) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    attempt += 1;
    let update: AttestationStatusUpdate = { attempt };
    try {
      const res = await fetch(url, { signal, cache: "no-store" });
      if (res.ok) {
        const body: unknown = await res.json();
        const messages = parseMessages(body);
        const first = messages[0];
        if (first) {
          const meta = extractStatusMeta(first);
          update = { attempt, status: first.status, ...meta };
        }
        const complete = messages.find(
          (m) => m.status === "complete" && m.message && m.attestation,
        );
        if (complete) {
          opts?.onPoll?.(update);
          return complete;
        }
      } else if (res.status !== 404) {
        console.warn(
          `pollAttestation: non-OK status ${res.status} for ${url}`,
        );
      }
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      console.warn("pollAttestation: fetch error", err);
    }
    opts?.onPoll?.(update);
    await delay(intervalMs, signal);
  }
}

/**
 * Compute max fee in 6-decimal CCTP subunits.
 * Iris returns minimumFee as a number which may be fractional (e.g. 1.3 bps).
 * Multiply at 1000× precision so fractional bps map to integer arithmetic.
 */
export function computeMaxFee(amount: bigint, minimumFeeBps: number): bigint {
  if (!minimumFeeBps || minimumFeeBps <= 0) return 0n;
  const scaled = BigInt(Math.round(minimumFeeBps * 1000));
  return (amount * scaled + 9_999_999n) / 10_000_000n; // ceil(amount * bps / 10_000)
}

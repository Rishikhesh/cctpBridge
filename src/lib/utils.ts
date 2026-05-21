import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function shortAddr(addr: string | null | undefined, head = 6, tail = 4) {
  if (!addr) return "";
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function formatUsdc(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const out = fracStr.length ? `${whole}.${fracStr}` : whole.toString();
  return negative ? `-${out}` : out;
}

/**
 * Format raw subunits to a fixed-precision human string.
 * E.g. formatUsdcFixed(100n, 6, 7) → "0.0001000"
 */
export function formatUsdcFixed(
  raw: bigint,
  decimals: number,
  fractionDigits: number,
): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let fracStr = frac.toString().padStart(decimals, "0");
  if (fractionDigits <= decimals) {
    fracStr = fracStr.slice(0, fractionDigits);
  } else {
    fracStr = fracStr + "0".repeat(fractionDigits - decimals);
  }
  const out = fractionDigits > 0 ? `${whole}.${fracStr}` : whole.toString();
  return negative ? `-${out}` : out;
}

/**
 * Walks common error shapes (Error, viem ContractFunctionError, WalletConnect
 * RPC error, nested cause chain) and returns the most human-readable string.
 * Never returns "[object Object]".
 */
export function formatError(err: unknown, fallback = "Unknown error"): string {
  if (err === null || err === undefined) return fallback;
  if (typeof err === "string") return err.trim() || fallback;
  if (typeof err === "number" || typeof err === "boolean") return String(err);

  if (err instanceof Error) {
    const parts: string[] = [];
    const e = err as Error & {
      shortMessage?: string;
      details?: string;
      reason?: string;
      cause?: unknown;
      code?: number | string;
    };
    const primary = e.shortMessage || e.message;
    if (primary) parts.push(primary);
    if (e.details && e.details !== primary) parts.push(e.details);
    if (e.reason && e.reason !== primary) parts.push(e.reason);
    if (e.code !== undefined) parts.push(`code=${e.code}`);
    if (e.cause) {
      const causeStr = formatError(e.cause, "");
      if (causeStr) parts.push(`cause: ${causeStr}`);
    }
    return parts.join(" · ") || fallback;
  }

  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    const candidates = [
      o.shortMessage,
      o.message,
      o.error,
      o.reason,
      o.details,
      o.data,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c;
      if (c && typeof c === "object" && "message" in c) {
        const inner = (c as { message: unknown }).message;
        if (typeof inner === "string" && inner.trim()) return inner;
      }
    }
    try {
      const json = JSON.stringify(err);
      if (json && json !== "{}") return json;
    } catch {
      // ignore
    }
  }
  return fallback;
}

export function parseUsdc(input: string, decimals: number): bigint {
  const trimmed = input.trim();
  if (!trimmed) return 0n;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("Invalid amount");
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(`Max ${decimals} decimals`);
  }
  const paddedFrac = frac.padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(paddedFrac || "0");
}

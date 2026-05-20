import { Horizon } from "@stellar/stellar-sdk";

export interface StellarBalances {
  xlm: string;
  usdc: string;
  usdcRaw: bigint;
  usdcTrustline: boolean;
}

const USDC_DECIMALS = 7;

function parseSubunits(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (trimmed.length === 0) return 0n;
  const neg = trimmed.startsWith("-");
  const body = neg ? trimmed.slice(1) : trimmed;
  const [intPartRaw, fracPartRaw = ""] = body.split(".");
  const intPart = intPartRaw.length === 0 ? "0" : intPartRaw;
  const fracPart = (fracPartRaw + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, "");
  const value = BigInt(combined.length === 0 ? "0" : combined);
  return neg ? -value : value;
}

function isStatusError(err: unknown, status: number): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { response?: { status?: unknown }; status?: unknown };
  if (e.response && typeof e.response.status === "number") {
    return e.response.status === status;
  }
  if (typeof e.status === "number") {
    return e.status === status;
  }
  return false;
}

export async function fetchStellarBalances(
  horizonUrl: string,
  publicKey: string,
  usdcIssuer: string,
): Promise<StellarBalances> {
  const server = new Horizon.Server(horizonUrl);
  let account: Awaited<ReturnType<typeof server.loadAccount>>;
  try {
    account = await server.loadAccount(publicKey);
  } catch (err) {
    if (isStatusError(err, 404)) {
      return { xlm: "0", usdc: "0", usdcRaw: 0n, usdcTrustline: false };
    }
    throw err;
  }

  let xlm = "0";
  let usdc = "0";
  let usdcRaw = 0n;
  let usdcTrustline = false;

  for (const balance of account.balances) {
    if (balance.asset_type === "native") {
      xlm = balance.balance;
      continue;
    }
    const b = balance as { asset_code?: string; asset_issuer?: string; balance: string };
    if (b.asset_code === "USDC" && b.asset_issuer === usdcIssuer) {
      usdc = b.balance;
      usdcRaw = parseSubunits(b.balance, USDC_DECIMALS);
      usdcTrustline = true;
    }
  }

  return { xlm, usdc, usdcRaw, usdcTrustline };
}

import { StrKey } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";

/**
 * Stellar contract strkey (C…) → 0x-prefixed bytes32 hex for EVM calls.
 */
export function contractStrkeyToBytes32(strkey: string): `0x${string}` {
  if (!StrKey.isValidContract(strkey)) {
    throw new Error(`Invalid contract strkey: ${strkey}`);
  }
  return `0x${Buffer.from(StrKey.decodeContract(strkey)).toString("hex")}`;
}

/**
 * Hook data layout per Circle CCTP Stellar Forwarder spec:
 *   bytes  0–23: reserved magic (zeroed)
 *   bytes 24–27: hook version (u32 BE, currently 0)
 *   bytes 28–31: forward_recipient byte length (u32 BE)
 *   bytes 32+  : forward_recipient (UTF-8 encoded Stellar strkey: G…/C…/M…)
 */
export function buildCctpForwarderHookData(
  forwardRecipientStrkey: string,
): `0x${string}` {
  const isValid =
    StrKey.isValidEd25519PublicKey(forwardRecipientStrkey) ||
    StrKey.isValidContract(forwardRecipientStrkey) ||
    StrKey.isValidMed25519PublicKey(forwardRecipientStrkey);
  if (!isValid) {
    throw new Error(
      `Invalid forward recipient: ${forwardRecipientStrkey} (expected G..., C..., or M... address)`,
    );
  }
  const recipientBytes = Buffer.from(forwardRecipientStrkey, "utf8");
  const hookData = Buffer.alloc(32 + recipientBytes.length);
  hookData.writeUInt32BE(0, 24);
  hookData.writeUInt32BE(recipientBytes.length, 28);
  recipientBytes.copy(hookData, 32);
  return `0x${hookData.toString("hex")}`;
}

export function isValidStellarRecipient(addr: string): boolean {
  return (
    StrKey.isValidEd25519PublicKey(addr) ||
    StrKey.isValidContract(addr) ||
    StrKey.isValidMed25519PublicKey(addr)
  );
}

export function stellarRecipientKind(addr: string): "G" | "C" | "M" | "invalid" {
  if (StrKey.isValidEd25519PublicKey(addr)) return "G";
  if (StrKey.isValidContract(addr)) return "C";
  if (StrKey.isValidMed25519PublicKey(addr)) return "M";
  return "invalid";
}

/**
 * Re-parse hookData we just built and verify it round-trips to the original
 * recipient strkey. Fund-safety assertion before broadcasting EVM->Stellar burn.
 */
export function assertHookDataRoundtrip(
  hookHex: `0x${string}`,
  expectedRecipient: string,
): void {
  const clean = hookHex.startsWith("0x") ? hookHex.slice(2) : hookHex;
  const bytes = Buffer.from(clean, "hex");
  if (bytes.length < 32 + expectedRecipient.length)
    throw new Error(`[safety] hookData too short`);
  for (let i = 0; i < 24; i++)
    if (bytes[i] !== 0) throw new Error(`[safety] hookData magic byte ${i} not zero`);
  const version = bytes.readUInt32BE(24);
  if (version !== 0)
    throw new Error(`[safety] hookData version expected 0, got ${version}`);
  const len = bytes.readUInt32BE(28);
  if (len !== expectedRecipient.length)
    throw new Error(
      `[safety] hookData length mismatch: encoded ${len}, expected ${expectedRecipient.length}`,
    );
  const decoded = bytes.slice(32, 32 + len).toString("utf8");
  if (decoded !== expectedRecipient)
    throw new Error(
      `[safety] hookData recipient mismatch: encoded ${decoded}, expected ${expectedRecipient}`,
    );
}

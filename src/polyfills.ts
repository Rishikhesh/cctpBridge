// MUST be imported as the very first side-effect in main.tsx.
// Solana SPL Token + Anchor + Stellar SDK reach for Node-style `Buffer`
// and `global` at module top-level. Without this they throw
// "Buffer is not defined" before our app code ever runs.
import { Buffer } from "buffer";

const g = globalThis as unknown as {
  Buffer?: typeof Buffer;
  global?: typeof globalThis;
  process?: { env: Record<string, string> };
};

if (!g.Buffer) g.Buffer = Buffer;
if (!g.global) g.global = globalThis;
if (!g.process) g.process = { env: {} };

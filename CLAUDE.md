# CCTP Bridge

USDC cross-chain transfer UI on top of Circle's CCTP V2 (burn-and-mint). Routes:
Stellar ↔ EVM, EVM ↔ EVM, EVM ↔ Solana (catalog only — Solana programs not yet wired).

## Stack

- Bun + Vite + React 19 + TypeScript
- Tailwind v4 (via `@tailwindcss/vite`), no PostCSS config
- Motion (Framer Motion v12 rebrand) for transitions/modals
- `@stellar/stellar-sdk` (Soroban RPC + Horizon)
- `@creit.tech/stellar-wallets-kit` (Freighter + multi-wallet; static `StellarWalletsKit.*` API)
- `viem` for EVM transactions + ERC-20 reads (via `window.ethereum`)
- Brutalist Editorial Fashion design system (canonical tokens at
  `~/personal/designSystems/brutalist-editorial-fashion/`, light/dark via
  `data-theme` on `<html>`). Site name is **CCTP Bridge**, never "Stellar CCTP".

## Layout

- Two-column desktop, stacked mobile. Left = form, right = sticky Quote + Status rail.
- Top header sticky w/ wallet pills (Stellar + EVM), network toggle, theme toggle, Refs button.
- Editorial section headers `01 / FROM`, `02 / TO`, `03 / RECIPIENT`, `04 / TRANSFER MODE`.

## Direction routing (see `src/App.tsx > handleBridge`)

| Direction        | Source-side                                        | Dest-side                                                  |
| ---------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| `stellar->evm`   | `approve` + `deposit_for_burn` on TMM (Soroban)    | viem `receiveMessage` on V2 MessageTransmitter             |
| `evm->evm`       | `approve` + `depositForBurn` on V2 TokenMessenger  | viem `receiveMessage` on dest V2 MessageTransmitter        |
| `evm->stellar`   | `approve` + `depositForBurnWithHook` (forwarder)   | `mint_and_forward` on Stellar `CctpForwarder` (Soroban)    |

**CctpForwarder rule** (per Circle docs): used **only for EVM→Stellar**.
Both `mintRecipient` and `destinationCaller` MUST be the forwarder strkey
(`contractStrkeyToBytes32`); `hookData` carries the real Stellar recipient
strkey via `buildCctpForwarderHookData`. Anything else → funds permanently
stuck.

## Decimals

- Stellar USDC = **7-dec subunits**, CCTP canonical = **6-dec subunits**.
- From Stellar: divide parsed amount by 10 to get canonical CCTP `amount`.
- To Stellar: scale received 6-dec amount up by 10 to display 7-dec.
- `formatUsdcFixed(raw, decimals, fractionDigits)` pads to fixed precision
  (used for fees so 1 bps on 1 USDC shows `0.0001000`).

## Fees

- `fetchBurnFees(irisApiUrl, src, dst)` → `{fast, slow}` `BurnFee` (`minimumFee` in bps).
- `computeMaxFee(amount, bps)` handles fractional bps (Iris returns e.g. 1.3) via 1000×
  scaling before BigInt ceil.
- Fees come from `/v2/burn/usdc/fees/{src}/{dst}`. Many pairs are 0 bps; Standard
  burn is almost always 0 bps. This is real Circle pricing, not a display bug.

## Tracking

- `pollAttestation` polls `/v2/messages/{srcDomain}?transactionHash=…` until
  `status === "complete"`. Emits intermediate `AttestationStatusUpdate` via `onPoll`
  with `irisStatus`, `finalityThresholdExecuted`, `feeExecuted`.
- `CCTP_FINALITY_ETA_SECONDS` provides per-source-domain ETA in seconds for fast/standard.
  Used to drive the live countdown bar.
- Destination mint tracked via `waitForTransactionReceipt` (EVM) or Soroban
  `getTransaction` poll (Stellar).
- No public Iris registry endpoint for chains/tokens — `/v2/chains`, `/v2/domains`,
  `/v2/supportedChainsAndDomains` all 404. Catalog is hardcoded in `src/lib/cctp.ts`.

## RPC providers (free public)

| Chain     | RPC                                                            |
| --------- | -------------------------------------------------------------- |
| Ethereum  | `https://ethereum-rpc.publicnode.com`                          |
| Base      | `https://base-rpc.publicnode.com`                              |
| Arbitrum  | `https://arbitrum.drpc.org`                                    |
| Avalanche | `https://avalanche.api.onfinality.io/public/ext/bc/C/rpc`      |
| Polygon   | `https://rpc.private.mev-x.com/polygon`                        |
| BNB       | `https://bsc.rpc.blxrbdn.com`                                  |
| Stellar   | `https://mainnet.sorobanrpc.com` (Horizon: `horizon.stellar.org`) |
| Solana    | `https://api.mainnet-beta.solana.com` (devnet equivalent for testnet) |

Testnets use publicnode equivalents (Sepolia, Base Sepolia, Arbitrum Sepolia,
Avalanche Fuji, Polygon Amoy) + `soroban-testnet.stellar.org`.

## Where things live

- `src/lib/cctp.ts` — full chain + contract catalog (testnet/mainnet,
  Stellar CCTP V2 contract IDs, EVM V2 standard deployment, Solana programs,
  USDC addresses per chain).
- `src/lib/bridge.ts` — Stellar source flow (`executeDepositForBurn`) +
  `mintAndForwardOnStellar` (Stellar forwarder receive side).
- `src/lib/evm.ts` — viem ABIs for `TokenMessengerV2`, `MessageTransmitterV2`,
  ERC-20. `evmConnect`, `evmSwitchChain`, `evmApproveUsdc`, `evmDepositForBurn`,
  `callReceiveMessage`, `fetchEvmUsdcBalance`, `fetchEvmUsdcAllowance`.
- `src/lib/stellar-utils.ts` — `contractStrkeyToBytes32`,
  `buildCctpForwarderHookData`, `isValidStellarRecipient`.
- `src/lib/attestation.ts` — Iris fees + attestation polling + ETA constants.
- `src/lib/balance.ts` — Horizon-based Stellar USDC balance (XLM, USDC, trustline flag).
- `src/lib/wallet.ts` — Stellar Wallets Kit singleton (v2.2 static API:
  `StellarWalletsKit.init` / `authModal` / `signTransaction`).
- `src/hooks/useWallet.ts` — Stellar wallet React glue (connect, persist, network switch).
- `src/hooks/useEvmWallet.ts` — `window.ethereum` adapter (connect, account/chain
  listeners, switch chain).
- `src/hooks/useTheme.ts` — light/dark toggle persisted to `localStorage`.
- `src/components/ChainPicker.tsx` — modal-style picker with search + unsupported
  filter (currently disables EVM→Solana destinations, etc.).
- `src/components/Modal.tsx` — Motion-driven modal primitive.
- `src/components/StatusTimeline.tsx` — brutalist numbered timeline w/ active
  step solid-fill icon for high contrast.
- `src/components/ui/*` — hand-rolled shadcn primitives (Button, Card, Input,
  Label, Select, Badge, Skeleton, Alert, Separator). No Radix.

## Commands

```bash
bun install         # install deps
bun dev             # vite dev server (default 5173)
bun run build       # tsc -b && vite build (strict TS, no implicit any)
bun run lint        # eslint
```

## Conventions

- No rounded corners (`--radius: 0px` everywhere).
- Eyebrows mono caps, 10px, tracking `0.25em` — use `.eyebrow` class.
- Display headlines use **Inter Tight**, body **Inter**, technical/data **JetBrains Mono**.
- Accent is editorial red (`#e6321b` light / `#ff4a2e` dark). Never lime, never gradients.
- Tabular numerics globally (`font-variant-numeric: tabular-nums`).
- Decimals: display USDC values with **7 fractional digits max** when showing fees.

## Notes

- Solana support is catalog-only. Adding Phantom/Backpack + Anchor IDLs for
  `MessageTransmitterV2.receive_message` instruction is the next step to make
  Solana destinations work.
- BNB testnet not in catalog yet; mainnet domain id 17 is wired.
- Iris API uses `cache: "no-store"` so requests are visible in DevTools Network
  every time (not cached).

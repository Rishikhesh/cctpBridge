import {
  StellarWalletsKit,
  Networks,
  type ISupportedWallet,
} from "@creit.tech/stellar-wallets-kit";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import { FREIGHTER_ID } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import {
  WalletConnectModule,
  WalletConnectTargetChain,
} from "@creit.tech/stellar-wallets-kit/modules/wallet-connect";
import {
  LEDGER_ID,
  LedgerModule,
} from "@creit.tech/stellar-wallets-kit/modules/ledger";
import {
  hardwareWalletPaths,
  activeAddress as kitActiveAddress,
} from "@creit.tech/stellar-wallets-kit/state";
import type { StellarNetwork } from "./cctp";

export interface ConnectedWallet {
  address: string;
}

let initialized = false;
let currentNetwork: StellarNetwork | null = null;

function networkEnum(net: StellarNetwork): Networks {
  return net === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

const WC_PROJECT_ID = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "").trim();

// Cache the WC module across HMR / re-init to avoid
// "WalletConnect Core is already initialized. Init() was called 2 times".
const G = globalThis as unknown as {
  __cctpWcModule?: WalletConnectModule;
  __cctpWcNet?: StellarNetwork;
};

function getOrCreateWcModule(net: StellarNetwork): WalletConnectModule | null {
  if (!WC_PROJECT_ID) return null;
  if (G.__cctpWcModule && G.__cctpWcNet === net) return G.__cctpWcModule;
  // If only the network changed, the module is sticky to its allowedChains —
  // safer to keep the existing instance and let the kit drive network swap.
  if (G.__cctpWcModule) return G.__cctpWcModule;
  try {
    G.__cctpWcModule = new WalletConnectModule({
      projectId: WC_PROJECT_ID,
      allowedChains: [
        WalletConnectTargetChain.PUBLIC,
        WalletConnectTargetChain.TESTNET,
      ],
      metadata: {
        name: "CCTP Bridge",
        description: "USDC cross-chain via Circle CCTP V2",
        url: typeof window !== "undefined" ? window.location.origin : "",
        icons: [
          typeof window !== "undefined"
            ? `${window.location.origin}/favicon.svg`
            : "",
        ],
      },
    });
    G.__cctpWcNet = net;
    return G.__cctpWcModule;
  } catch (e) {
    console.warn("[CCTP] WalletConnect module init failed:", e);
    return null;
  }
}

// Single Ledger module instance — uses WebUSB/WebHID transport which the
// kit lazy-opens on getAddress / sign calls. Safe to keep across networks.
const G_LEDGER = globalThis as unknown as { __cctpLedger?: LedgerModule };
function getLedgerModule(): LedgerModule {
  if (!G_LEDGER.__cctpLedger) {
    G_LEDGER.__cctpLedger = new LedgerModule();
  }
  return G_LEDGER.__cctpLedger;
}

function buildModules(net: StellarNetwork) {
  const mods = defaultModules();
  const wc = getOrCreateWcModule(net);
  if (wc) mods.push(wc);
  mods.push(getLedgerModule());
  return mods;
}

function ensureInit(network: StellarNetwork) {
  if (!initialized) {
    StellarWalletsKit.init({
      network: networkEnum(network),
      selectedWalletId: FREIGHTER_ID,
      modules: buildModules(network),
    });
    initialized = true;
    currentNetwork = network;
    return;
  }
  if (currentNetwork !== network) {
    StellarWalletsKit.setNetwork(networkEnum(network));
    currentNetwork = network;
  }
}

/**
 * Returns the full list of wallet options from the kit (Freighter, xBull,
 * LOBSTR, WalletConnect, Albedo, hardware wallets, etc.). Marks installed
 * via `isAvailable`. Used by our custom brutalist picker modal.
 */
export async function listAvailableWallets(
  network: StellarNetwork,
): Promise<ISupportedWallet[]> {
  ensureInit(network);
  const list = await StellarWalletsKit.refreshSupportedWallets();
  return list;
}

/**
 * Selects a wallet by id (e.g. FREIGHTER_ID, "wallet_connect"), prompts for
 * address, returns it. Replaces the built-in authModal so we can render our
 * own UI matching the brutalist editorial design system.
 */
/**
 * Stellar Ledger path-resolution: kit's authModal normally lets the user pick
 * an account index then writes the path into its internal signal. We use a
 * custom picker so that step is skipped — first call to getAddress hits
 * `mnemonicPath.value === undefined` and crashes with "Cannot read properties
 * of undefined (reading 'split')". Fix: read selected index, then register
 * the path in kit state ourselves so signTransaction can find it.
 */
async function resolveLedgerAddress(accountIndex: number): Promise<string> {
  const ledger = getLedgerModule();
  const path = `44'/148'/${accountIndex}'`;
  const { address } = await ledger.getAddress({ path });
  if (!address) throw new Error("Ledger returned empty address");
  const current = hardwareWalletPaths.value ?? [];
  const next = current
    .filter((e) => e.publicKey !== address)
    .concat([{ publicKey: address, index: accountIndex }]);
  hardwareWalletPaths.value = next;
  kitActiveAddress.value = address;
  return address;
}

export interface LedgerAccountOption {
  index: number;
  address: string;
}

/**
 * Reads N consecutive Stellar derivations from the connected Ledger so the
 * user can pick which account to sign with. Stops on first transport error.
 */
export async function listLedgerAccounts(
  count = 5,
): Promise<LedgerAccountOption[]> {
  const ledger = getLedgerModule();
  const out: LedgerAccountOption[] = [];
  for (let i = 0; i < count; i++) {
    const path = `44'/148'/${i}'`;
    const { address } = await ledger.getAddress({ path });
    if (!address) break;
    out.push({ index: i, address });
  }
  return out;
}

/**
 * Finalize Ledger connection on a chosen account index. Network is the
 * Stellar network for sign-network-passphrase routing.
 */
export async function selectLedgerAccount(
  network: StellarNetwork,
  accountIndex: number,
): Promise<ConnectedWallet> {
  ensureInit(network);
  StellarWalletsKit.setWallet(LEDGER_ID);
  const address = await resolveLedgerAddress(accountIndex);
  return { address };
}

export async function selectWallet(
  network: StellarNetwork,
  walletId: string,
): Promise<ConnectedWallet> {
  // WalletConnect v2 Core is page-singleton — two WC SignClients collide.
  // Auto-disconnect the EVM WC session before pairing Stellar WC, and emit
  // an event so useEvmWallet can clear its React state.
  if (
    walletId === "wallet_connect" &&
    typeof localStorage !== "undefined" &&
    localStorage.getItem("cctp:evmKind") === "walletconnect"
  ) {
    const { wcEvmDisconnect } = await import("./evm-walletconnect");
    await wcEvmDisconnect();
    localStorage.removeItem("cctp:evmAddress");
    localStorage.removeItem("cctp:evmKind");
    window.dispatchEvent(new Event("cctp:evm-force-disconnect"));
    // Give WC Core a beat to fully release before a new WC SignClient
    // claims its singleton seat.
    await new Promise((r) => setTimeout(r, 300));
  }
  ensureInit(network);
  StellarWalletsKit.setWallet(walletId);

  // Ledger needs explicit BIP path setup before fetchAddress.
  // Callers should normally use selectLedgerAccount(net, index) with an
  // index chosen via listLedgerAccounts; this fallback uses index 0.
  if (walletId === LEDGER_ID) {
    const address = await resolveLedgerAddress(0);
    return { address };
  }

  // fetchAddress runs the module's actual handshake (e.g. WalletConnect QR
  // pairing, Freighter permission prompt). getAddress reads from kit memory
  // and returns empty if no prior session — that surfaces as the misleading
  // "No wallet has been connected" error for first-time WC users.
  const { address } = await StellarWalletsKit.fetchAddress();
  if (!address) throw new Error("Wallet returned empty address");
  return { address };
}

export async function disconnectWallet(): Promise<void> {
  if (!initialized) return;
  try {
    await StellarWalletsKit.disconnect();
  } catch {
    // ignore
  }
  // Reset the kit's active module back to the default so a subsequent
  // reconnect doesn't accidentally route through the previously-paired
  // module (e.g. WalletConnect session that's still cached internally).
  try {
    StellarWalletsKit.setWallet(FREIGHTER_ID);
  } catch {
    // ignore
  }
}

export async function getConnectedAddress(
  network: StellarNetwork,
): Promise<string | null> {
  ensureInit(network);
  try {
    const { address } = await StellarWalletsKit.getAddress();
    return address || null;
  } catch {
    return null;
  }
}

/**
 * Forcibly select a wallet module by id (e.g. on session restore so the kit
 * knows we previously paired via WalletConnect / LOBSTR / xBull and not the
 * default Freighter — otherwise signing routes through the wrong module and
 * fails with "Freighter is not connected").
 */
export function setActiveWalletId(network: StellarNetwork, walletId: string): void {
  ensureInit(network);
  StellarWalletsKit.setWallet(walletId);
}

function errString(e: unknown): string {
  if (e instanceof Error) return `${e.message} ${(e as { details?: string }).details ?? ""}`;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function isStaleWcSessionError(e: unknown): boolean {
  return /session topic does not exist|No matching key|pending session not found/i.test(
    errString(e),
  );
}

function isUnsupportedSorobanOpError(e: unknown): boolean {
  return /invokeHostFunction|unsupported operation|hostFunction|soroban/i.test(
    errString(e),
  );
}

function isUserRejection(e: unknown): boolean {
  const s = errString(e);
  // 0x6985 = Ledger user rejection APDU. 4001 = EIP-1193 user rejection.
  return /user rejected|user denied|user declined|rejected by the user|declined transaction|user cancel|0x6985|\\b4001\\b/i.test(
    s,
  );
}

function isLedgerNotReady(e: unknown): boolean {
  const s = errString(e);
  return /no device selected|locked|app is not open|UNKNOWN_APDU|cla_not_supported|0x6a00|0x6e00|0x6d00|TransportStatusError/i.test(
    s,
  );
}

function isLedgerBlindSign(e: unknown): boolean {
  return /blind sign|blind signing|enable blind|blind-signing/i.test(errString(e));
}

async function purgeStaleWcSession(): Promise<void> {
  // Wipe any cached WC sign-client session data on this origin so the next
  // connect rebuilds cleanly. Safe — only touches WC keys.
  try {
    await StellarWalletsKit.disconnect();
  } catch {
    // ignore
  }
  if (typeof localStorage !== "undefined") {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("wc@2") || key.startsWith("WALLETCONNECT_")) {
        localStorage.removeItem(key);
      }
    }
  }
}

export async function signXdr(
  network: StellarNetwork,
  xdr: string,
  networkPassphrase: string,
  address: string,
): Promise<string> {
  ensureInit(network);
  let signedTxXdr: string;
  try {
    ({ signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
      networkPassphrase,
      address,
    }));
  } catch (e) {
    if (isUserRejection(e)) {
      throw new Error("You rejected the signing request in your Stellar wallet.");
    }
    if (isStaleWcSessionError(e)) {
      await purgeStaleWcSession();
      throw new Error(
        "Your WalletConnect session expired. Disconnect Stellar wallet and reconnect to continue.",
      );
    }
    if (isUnsupportedSorobanOpError(e)) {
      throw new Error(
        "Your Stellar wallet doesn't support Soroban (invokeHostFunction). CCTP requires Soroban signing. Update your wallet app (Ledger Stellar app v6.0+) or switch to Freighter / LOBSTR / xBull / Hana.",
      );
    }
    if (isLedgerBlindSign(e)) {
      throw new Error(
        "Enable 'Blind signing' in the Stellar app on your Ledger device, then retry. Settings → Stellar → Blind signing → Enabled.",
      );
    }
    if (isLedgerNotReady(e)) {
      throw new Error(
        "Ledger not ready: unlock your device, open the Stellar app (v6.0+), and approve the WebUSB connection in the browser.",
      );
    }
    throw new Error(`Stellar sign failed: ${errString(e)}`);
  }
  // Defense-in-depth: kit returned successfully but no signed XDR.
  if (!signedTxXdr || typeof signedTxXdr !== "string") {
    throw new Error("Stellar wallet returned an empty signature. Retry.");
  }
  return signedTxXdr;
}

export const WALLETCONNECT_ENABLED = WC_PROJECT_ID.length > 0;

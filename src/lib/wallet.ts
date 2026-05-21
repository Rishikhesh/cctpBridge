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

function buildModules(net: StellarNetwork) {
  const mods = defaultModules();
  const wc = getOrCreateWcModule(net);
  if (wc) mods.push(wc);
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
export async function selectWallet(
  network: StellarNetwork,
  walletId: string,
): Promise<ConnectedWallet> {
  // WalletConnect v2 Core is a page-level singleton. Two SignClients (one
  // for Stellar, one for EVM) cause session-topic drops + "already
  // initialized" warnings, and clobber each other's storage. Refuse to pair
  // a Stellar WC session while an EVM WC session is live.
  if (
    walletId === "wallet_connect" &&
    typeof localStorage !== "undefined" &&
    localStorage.getItem("cctp:evmKind") === "walletconnect"
  ) {
    throw new Error(
      "Disconnect your EVM WalletConnect session first. WalletConnect can only run one chain at a time per page. Use Freighter or a browser EVM wallet to keep both connected.",
    );
  }
  ensureInit(network);
  StellarWalletsKit.setWallet(walletId);
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

function isStaleWcSessionError(e: unknown): boolean {
  const s = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /session topic does not exist|No matching key/i.test(s);
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
  try {
    const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
      networkPassphrase,
      address,
    });
    return signedTxXdr;
  } catch (e) {
    if (isStaleWcSessionError(e)) {
      await purgeStaleWcSession();
      throw new Error(
        "Your WalletConnect session expired. Disconnect Stellar wallet and reconnect to continue.",
      );
    }
    throw e;
  }
}

export const WALLETCONNECT_ENABLED = WC_PROJECT_ID.length > 0;

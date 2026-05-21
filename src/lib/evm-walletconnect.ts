import { EthereumProvider } from "@walletconnect/ethereum-provider";
import { CHAINS_MAINNET, CHAINS_TESTNET, type ChainInfo } from "./cctp";

/**
 * Lazy-built singleton EIP-1193 provider over WalletConnect v2.
 * Cached on globalThis to survive Vite HMR / React StrictMode.
 */
const G = globalThis as unknown as {
  __cctpWcEthProvider?: Awaited<ReturnType<typeof EthereumProvider.init>>;
  __cctpWcEthInit?: Promise<Awaited<ReturnType<typeof EthereumProvider.init>>>;
};

const PROJECT_ID =
  (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "").trim();

export const WC_EVM_ENABLED = PROJECT_ID.length > 0;

function evmChainList(): ChainInfo[] {
  return [...CHAINS_MAINNET, ...CHAINS_TESTNET].filter((c) => c.kind === "evm");
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `${label} timed out after ${ms}ms. Disconnect and try again — back-to-back WalletConnect inits can hang on the relay.`,
            ),
          ),
        ms,
      ),
    ),
  ]);
}

export async function getWcEvmProvider(): Promise<
  Awaited<ReturnType<typeof EthereumProvider.init>>
> {
  if (!PROJECT_ID) {
    throw new Error(
      "WalletConnect disabled — set VITE_WALLETCONNECT_PROJECT_ID in .env.local",
    );
  }
  if (G.__cctpWcEthProvider) return G.__cctpWcEthProvider;
  if (G.__cctpWcEthInit) return G.__cctpWcEthInit;

  const evmChains = evmChainList();
  const allChainIds = evmChains.map((c) => c.evm!.chainId);
  const rpcMap: Record<number, string> = {};
  for (const c of evmChains) {
    if (c.evm) rpcMap[c.evm.chainId] = c.evm.rpcUrl;
  }

  // Use the first mainnet EVM as default ("chains"). Others go in
  // "optionalChains" so the user can switch via wallet_switchEthereumChain
  // without re-pairing.
  const [primary, ...optional] = allChainIds;

  const initPromise = EthereumProvider.init({
    projectId: PROJECT_ID,
    chains: [primary],
    optionalChains: optional,
    rpcMap,
    // AppKit modal is fine because we enforce one WC session at a time at
    // the app level (see selectWallet / connectWalletConnect gates) —
    // the AppKit singleton never has two consumers concurrently.
    showQrModal: true,
    methods: [
      "eth_sendTransaction",
      "eth_signTransaction",
      "personal_sign",
      "eth_signTypedData_v4",
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
    ],
    events: ["chainChanged", "accountsChanged", "disconnect"],
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

  // Wrap with timeout so a stalled init never hangs the UI forever.
  // On timeout we clear the cached promise so the next click retries cleanly.
  G.__cctpWcEthInit = withTimeout(initPromise, 20000, "WalletConnect init")
    .then((p) => {
      G.__cctpWcEthProvider = p;
      return p;
    })
    .catch((err) => {
      G.__cctpWcEthInit = undefined;
      G.__cctpWcEthProvider = undefined;
      throw err;
    });

  return G.__cctpWcEthInit;
}

/**
 * Triggers WC pairing (opens QR modal). Resolves with the connected address.
 * Idempotent — if already connected returns the existing account.
 */
export async function wcEvmConnect(): Promise<string> {
  const p = await getWcEvmProvider();
  if (!p.session) {
    try {
      await withTimeout(p.connect(), 5 * 60 * 1000, "WalletConnect pairing");
    } catch (err) {
      // Drop cached provider on failure so retry starts fresh.
      G.__cctpWcEthProvider = undefined;
      G.__cctpWcEthInit = undefined;
      try {
        await p.disconnect();
      } catch {
        // ignore
      }
      throw err;
    }
  }
  const accounts = (await p.request({ method: "eth_accounts" })) as string[];
  if (!accounts || accounts.length === 0) {
    throw new Error("WalletConnect returned no accounts");
  }
  return accounts[0];
}

export async function wcEvmDisconnect(): Promise<void> {
  if (!G.__cctpWcEthProvider) return;
  try {
    await G.__cctpWcEthProvider.disconnect();
  } catch {
    // ignore
  }
  // Drop the cached singleton so the next connect builds a fresh provider
  // with a brand-new pairing topic — avoids any leftover relay/session state.
  G.__cctpWcEthProvider = undefined;
  G.__cctpWcEthInit = undefined;
}

export function wcEvmHasSession(): boolean {
  return !!G.__cctpWcEthProvider?.session;
}

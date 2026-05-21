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

  G.__cctpWcEthInit = EthereumProvider.init({
    projectId: PROJECT_ID,
    chains: [primary],
    optionalChains: optional,
    rpcMap,
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
  }).then((p) => {
    G.__cctpWcEthProvider = p;
    return p;
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
    await p.connect();
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
}

export function wcEvmHasSession(): boolean {
  return !!G.__cctpWcEthProvider?.session;
}

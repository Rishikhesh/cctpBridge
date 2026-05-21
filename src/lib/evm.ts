import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  http,
  isAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { ChainInfo, EvmContracts } from "./cctp";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000".toLowerCase();
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as const;

function assertEvmRecipient(addr: string, label: string) {
  if (!isAddress(addr)) throw new Error(`[safety] ${label} not a valid EVM address: ${addr}`);
  if (addr.toLowerCase() === ZERO_ADDRESS)
    throw new Error(`[safety] ${label} cannot be the zero address`);
}

function assertBytes32(hex: string, label: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`[safety] ${label} not bytes32: ${hex}`);
  }
}

// EIP-1193 provider shape we rely on. Both `window.ethereum` (MetaMask /
// injected) and WalletConnect's EthereumProvider implement this surface.
export interface InjectedEvmProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
  isMetaMask?: boolean;
}

export type EvmProviderKind = "injected" | "walletconnect";

// Active provider for the current session. Swap via setActiveEvmProvider.
let activeProvider: InjectedEvmProvider | null = null;
let activeKind: EvmProviderKind | null = null;

export function setActiveEvmProvider(
  p: InjectedEvmProvider | null,
  kind: EvmProviderKind | null,
): void {
  activeProvider = p;
  activeKind = kind;
}

export function getActiveProviderKind(): EvmProviderKind | null {
  return activeKind;
}

function readInjected(): InjectedEvmProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { ethereum?: unknown };
  if (!w.ethereum) return null;
  return w.ethereum as InjectedEvmProvider;
}

function readEthereum(): InjectedEvmProvider | null {
  if (activeProvider) return activeProvider;
  return readInjected();
}

export function hasInjectedEthereum(): boolean {
  return readInjected() !== null;
}

export const MESSAGE_TRANSMITTER_V2_ABI = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "usedNonces",
    stateMutability: "view",
    inputs: [{ name: "nonce", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const TOKEN_MESSENGER_V2_ABI = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "depositForBurnWithHook",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export function hasEthereumProvider(): boolean {
  return readEthereum() !== null;
}

function ensureProvider(): InjectedEvmProvider {
  const eth = readEthereum();
  if (!eth) {
    throw new Error(
      "No EVM wallet active. Connect MetaMask or WalletConnect first.",
    );
  }
  return eth;
}

export async function evmConnect(): Promise<Address> {
  const eth = ensureProvider();
  const accounts = (await eth.request({
    method: "eth_requestAccounts",
  })) as Address[];
  if (!accounts || accounts.length === 0) throw new Error("No account returned");
  return accounts[0];
}

export async function evmChainId(): Promise<number> {
  const eth = ensureProvider();
  const hex = (await eth.request({ method: "eth_chainId" })) as string;
  return parseInt(hex, 16);
}

async function waitForChainId(target: number, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const id = await evmChainId();
    if (id === target) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Wallet did not switch chain to ${target} within ${timeoutMs}ms — open your wallet and confirm the chain switch.`,
  );
}

export async function evmSwitchChain(chain: ChainInfo): Promise<void> {
  if (!chain.evm) throw new Error(`No EVM config for chain ${chain.name}`);
  const eth = ensureProvider();
  const hexId = `0x${chain.evm.chainId.toString(16)}`;
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexId }],
    });
  } catch (err: unknown) {
    const e = err as { code?: number };
    if (e?.code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hexId,
            chainName: chain.name,
            nativeCurrency: {
              name: chain.evm.nativeSymbol,
              symbol: chain.evm.nativeSymbol,
              decimals: 18,
            },
            rpcUrls: [chain.evm.rpcUrl],
            blockExplorerUrls: [
              chain.explorerTxUrl("").replace(/\/tx\/?$/, ""),
            ],
          },
        ],
      });
    } else {
      throw err;
    }
  }
  // Block until provider reports the new chain (avoids race with viem sendTransaction)
  await waitForChainId(chain.evm.chainId);
}

async function ensureOnChain(chain: ChainInfo): Promise<void> {
  if (!chain.evm) throw new Error(`No EVM config for chain ${chain.name}`);
  const current = await evmChainId();
  if (current === chain.evm.chainId) return;
  await evmSwitchChain(chain);
}

function publicClient(evm: EvmContracts): PublicClient {
  return createPublicClient({ transport: http(evm.rpcUrl) }) as PublicClient;
}

function walletClient(): WalletClient {
  const eth = ensureProvider();
  return createWalletClient({ transport: custom(eth) }) as WalletClient;
}

export async function isMessageUsed(
  chain: ChainInfo,
  nonceHex: Hex,
): Promise<boolean> {
  if (!chain.evm) throw new Error(`No EVM config for chain ${chain.name}`);
  const client = publicClient(chain.evm);
  const used = (await client.readContract({
    address: chain.evm.messageTransmitter,
    abi: MESSAGE_TRANSMITTER_V2_ABI,
    functionName: "usedNonces",
    args: [nonceHex],
  })) as bigint;
  return used !== 0n;
}

export interface ReceiveMessageResult {
  txHash: Hex;
}

export async function callReceiveMessage(
  chain: ChainInfo,
  account: Address,
  messageHex: string,
  attestationHex: string,
): Promise<ReceiveMessageResult> {
  if (!chain.evm) throw new Error(`No EVM config for chain ${chain.name}`);
  await ensureOnChain(chain);
  const current = await evmChainId();
  if (current !== chain.evm.chainId) {
    throw new Error(
      `Wallet still on chain ${current}, expected ${chain.evm.chainId} (${chain.name}). Refusing to submit receiveMessage to wrong chain.`,
    );
  }
  await assertLiveAccount(account);

  const pub = publicClient(chain.evm);
  // Dry-run via simulate to catch reverts (wrong dest domain, replay, etc.)
  await pub.simulateContract({
    address: chain.evm.messageTransmitter,
    abi: MESSAGE_TRANSMITTER_V2_ABI,
    functionName: "receiveMessage",
    args: [messageHex as Hex, attestationHex as Hex],
    account,
  });

  const data = encodeFunctionData({
    abi: MESSAGE_TRANSMITTER_V2_ABI,
    functionName: "receiveMessage",
    args: [messageHex as Hex, attestationHex as Hex],
  });

  const gas = await estimateGasWithBuffer(pub, {
    account,
    to: chain.evm.messageTransmitter,
    data,
  });

  const wallet = walletClient();
  const hash = await wallet.sendTransaction({
    account,
    chain: null,
    to: chain.evm.messageTransmitter,
    data,
    gas,
  });
  return { txHash: hash };
}

export async function waitForReceipt(
  chain: ChainInfo,
  hash: Hex,
): Promise<"success" | "reverted"> {
  if (!chain.evm) throw new Error(`No EVM config for chain ${chain.name}`);
  const client = publicClient(chain.evm);
  const receipt = await client.waitForTransactionReceipt({ hash });
  return receipt.status === "success" ? "success" : "reverted";
}

export async function fetchEvmUsdcBalance(
  chain: ChainInfo,
  account: Address,
): Promise<bigint> {
  if (!chain.evm) throw new Error(`No EVM config for chain ${chain.name}`);
  const client = publicClient(chain.evm);
  const bal = (await client.readContract({
    address: chain.evm.usdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account],
  })) as bigint;
  return bal;
}

export async function fetchEvmUsdcAllowance(
  chain: ChainInfo,
  owner: Address,
): Promise<bigint> {
  if (!chain.evm) throw new Error(`No EVM config for chain ${chain.name}`);
  const client = publicClient(chain.evm);
  const allowance = (await client.readContract({
    address: chain.evm.usdc,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, chain.evm.tokenMessenger],
  })) as bigint;
  return allowance;
}

export async function evmApproveUsdc(
  chain: ChainInfo,
  account: Address,
  amount: bigint,
): Promise<Hex> {
  if (!chain.evm) throw new Error(`No EVM config for chain ${chain.name}`);
  await ensureOnChain(chain);
  if (amount <= 0n) throw new Error(`[safety] approve amount must be > 0`);
  await assertLiveAccount(account);

  const pub = publicClient(chain.evm);
  await pub.simulateContract({
    address: chain.evm.usdc,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [chain.evm.tokenMessenger, amount],
    account,
  });

  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [chain.evm.tokenMessenger, amount],
  });

  const gas = await estimateGasWithBuffer(pub, {
    account,
    to: chain.evm.usdc,
    data,
  });

  const wallet = walletClient();
  return wallet.sendTransaction({
    account,
    chain: null,
    to: chain.evm.usdc,
    data,
    gas,
  });
}

async function assertLiveAccount(expected: Address) {
  const accounts = (await ensureProvider().request({
    method: "eth_accounts",
  })) as string[];
  const live = accounts?.[0]?.toLowerCase();
  if (!live || live !== expected.toLowerCase()) {
    throw new Error(
      `[safety] EVM wallet account mismatch: expected ${expected}, got ${live ?? "none"}. Aborting.`,
    );
  }
}

async function estimateGasWithBuffer(
  pub: PublicClient,
  args: { account: Address; to: Address; data: Hex },
): Promise<bigint> {
  try {
    const est = await pub.estimateGas({
      account: args.account,
      to: args.to,
      data: args.data,
    });
    // 25% buffer to absorb chain congestion + state shifts between sim and send.
    return (est * 125n) / 100n;
  } catch {
    // If estimateGas fails (some chains require state context the public RPC
    // lacks), let the wallet estimate. Safer than guessing wrong.
    return 0n;
  }
}

export interface EvmDepositForBurnArgs {
  amount: bigint;
  destinationDomain: number;
  mintRecipient: Hex;        // bytes32
  burnToken: Address;
  destinationCaller: Hex;    // bytes32
  maxFee: bigint;
  minFinalityThreshold: number;
  hookData?: Hex;            // when provided uses depositForBurnWithHook
}

export async function evmDepositForBurn(
  chain: ChainInfo,
  account: Address,
  args: EvmDepositForBurnArgs,
): Promise<Hex> {
  if (!chain.evm) throw new Error(`No EVM config for chain ${chain.name}`);
  await ensureOnChain(chain);

  if (args.amount <= 0n) throw new Error(`[safety] burn amount must be > 0`);
  if (args.maxFee < 0n) throw new Error(`[safety] maxFee must be >= 0`);
  if (args.maxFee > args.amount)
    throw new Error(`[safety] maxFee (${args.maxFee}) exceeds amount (${args.amount})`);
  if (![1000, 2000].includes(args.minFinalityThreshold))
    throw new Error(
      `[safety] minFinalityThreshold must be 1000 (fast) or 2000 (standard), got ${args.minFinalityThreshold}`,
    );
  assertBytes32(args.mintRecipient, "mintRecipient");
  assertBytes32(args.destinationCaller, "destinationCaller");
  if (args.mintRecipient.toLowerCase() === ZERO_BYTES32)
    throw new Error(`[safety] mintRecipient is zero bytes32`);
  if (args.burnToken.toLowerCase() !== chain.evm.usdc.toLowerCase())
    throw new Error(
      `[safety] burnToken ${args.burnToken} does not match configured USDC ${chain.evm.usdc} on ${chain.name}`,
    );
  if (args.hookData && !/^0x[0-9a-fA-F]*$/.test(args.hookData))
    throw new Error(`[safety] hookData not hex`);

  await assertLiveAccount(account);

  // Dry-run via simulate to catch onchain reverts (allowance, fee schedule, etc.).
  const pub = publicClient(chain.evm);
  if (args.hookData) {
    await pub.simulateContract({
      address: chain.evm.tokenMessenger,
      abi: TOKEN_MESSENGER_V2_ABI,
      functionName: "depositForBurnWithHook",
      args: [
        args.amount,
        args.destinationDomain,
        args.mintRecipient,
        args.burnToken,
        args.destinationCaller,
        args.maxFee,
        args.minFinalityThreshold,
        args.hookData,
      ],
      account,
    });
  } else {
    await pub.simulateContract({
      address: chain.evm.tokenMessenger,
      abi: TOKEN_MESSENGER_V2_ABI,
      functionName: "depositForBurn",
      args: [
        args.amount,
        args.destinationDomain,
        args.mintRecipient,
        args.burnToken,
        args.destinationCaller,
        args.maxFee,
        args.minFinalityThreshold,
      ],
      account,
    });
  }

  const data = args.hookData
    ? encodeFunctionData({
        abi: TOKEN_MESSENGER_V2_ABI,
        functionName: "depositForBurnWithHook",
        args: [
          args.amount,
          args.destinationDomain,
          args.mintRecipient,
          args.burnToken,
          args.destinationCaller,
          args.maxFee,
          args.minFinalityThreshold,
          args.hookData,
        ],
      })
    : encodeFunctionData({
        abi: TOKEN_MESSENGER_V2_ABI,
        functionName: "depositForBurn",
        args: [
          args.amount,
          args.destinationDomain,
          args.mintRecipient,
          args.burnToken,
          args.destinationCaller,
          args.maxFee,
          args.minFinalityThreshold,
        ],
      });

  const gas = await estimateGasWithBuffer(pub, {
    account,
    to: chain.evm.tokenMessenger,
    data,
  });

  const wallet = walletClient();
  return wallet.sendTransaction({
    account,
    chain: null,
    to: chain.evm.tokenMessenger,
    data,
    gas,
  });
}

export { assertEvmRecipient, assertBytes32, ZERO_ADDRESS, ZERO_BYTES32 };

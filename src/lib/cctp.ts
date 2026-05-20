import chainData from "@/data/chains.json";

export type StellarNetwork = "testnet" | "mainnet";

export interface CctpStellarConfig {
  network: StellarNetwork;
  networkPassphrase: string;
  sorobanRpcUrl: string;
  horizonUrl: string;
  tokenMessengerMinter: string;
  messageTransmitter: string;
  cctpForwarder: string;
  usdcContract: string;
  usdcIssuer: string;
  irisApiUrl: string;
  stellarExplorerTxUrl: (hash: string) => string;
}

export const STELLAR_DOMAIN_ID = 27;
export const USDC_DECIMALS_STELLAR = 7;
export const USDC_DECIMALS_CCTP = 6;
export const USDC_DECIMALS_EVM = 6;
export const USDC_DECIMALS_SOLANA = 6;

const IRIS_API = chainData.irisApi as Record<StellarNetwork, string>;
const EVM_V2 = chainData.evmV2Contracts as Record<
  StellarNetwork,
  { tokenMessenger: `0x${string}`; messageTransmitter: `0x${string}` }
>;

function buildStellarConfig(net: StellarNetwork): CctpStellarConfig {
  const s = chainData.stellar[net];
  return {
    network: net,
    networkPassphrase: s.networkPassphrase,
    sorobanRpcUrl: s.sorobanRpcUrl,
    horizonUrl: s.horizonUrl,
    tokenMessengerMinter: s.contracts.tokenMessengerMinter,
    messageTransmitter: s.contracts.messageTransmitter,
    cctpForwarder: s.contracts.cctpForwarder,
    usdcContract: s.contracts.usdcContract,
    usdcIssuer: s.contracts.usdcIssuer,
    irisApiUrl: IRIS_API[net],
    stellarExplorerTxUrl: (hash) => `${s.explorerTxBase}${hash}`,
  };
}

export const CCTP_CONFIGS: Record<StellarNetwork, CctpStellarConfig> = {
  mainnet: buildStellarConfig("mainnet"),
  testnet: buildStellarConfig("testnet"),
};

export type ChainKind = "stellar" | "evm" | "solana";

export interface EvmContracts {
  chainId: number;
  rpcUrl: string;
  nativeSymbol: string;
  tokenMessenger: `0x${string}`;
  messageTransmitter: `0x${string}`;
  usdc: `0x${string}`;
}

export interface SolanaContracts {
  rpcUrl: string;
  usdcMint: string;
  tokenMessenger: string;
  messageTransmitter: string;
}

export interface ChainInfo {
  id: string;
  name: string;
  shortName: string;
  domainId: number;
  kind: ChainKind;
  network: "mainnet" | "testnet";
  color: string;
  logoChar: string;
  supportedSource: boolean;
  explorerTxUrl: (hash: string) => string;
  evm?: EvmContracts;
  solana?: SolanaContracts;
}

interface JsonEvmChain {
  id: string;
  name: string;
  shortName: string;
  domainId: number;
  color: string;
  logoChar: string;
  chainId: number;
  nativeSymbol?: string;
  rpcUrl: string;
  usdc: string;
  explorerTxBase: string;
  supportedSource?: boolean;
}

interface JsonStellarChain {
  id: string;
  name: string;
  shortName: string;
  domainId: number;
  color: string;
  logoChar: string;
  supportedSource: boolean;
  explorerTxBase: string;
}

interface JsonSolanaChain {
  id: string;
  name: string;
  shortName: string;
  domainId: number;
  color: string;
  logoChar: string;
  supportedSource: boolean;
  rpcUrl: string;
  usdcMint: string;
  tokenMessenger: string;
  messageTransmitter: string;
  explorerTxBase: string;
  explorerTxSuffix?: string;
}

function buildEvmChain(j: JsonEvmChain, net: StellarNetwork): ChainInfo {
  const v2 = EVM_V2[net];
  return {
    id: j.id,
    name: j.name,
    shortName: j.shortName,
    domainId: j.domainId,
    kind: "evm",
    network: net,
    color: j.color,
    logoChar: j.logoChar,
    supportedSource: j.supportedSource ?? true,
    explorerTxUrl: (h) => `${j.explorerTxBase}${h}`,
    evm: {
      chainId: j.chainId,
      rpcUrl: j.rpcUrl,
      nativeSymbol: j.nativeSymbol ?? "ETH",
      tokenMessenger: v2.tokenMessenger,
      messageTransmitter: v2.messageTransmitter,
      usdc: j.usdc as `0x${string}`,
    },
  };
}

function buildStellarChain(j: JsonStellarChain, net: StellarNetwork): ChainInfo {
  return {
    id: j.id,
    name: j.name,
    shortName: j.shortName,
    domainId: j.domainId,
    kind: "stellar",
    network: net,
    color: j.color,
    logoChar: j.logoChar,
    supportedSource: j.supportedSource,
    explorerTxUrl: (h) => `${j.explorerTxBase}${h}`,
  };
}

function buildSolanaChain(j: JsonSolanaChain, net: StellarNetwork): ChainInfo {
  return {
    id: j.id,
    name: j.name,
    shortName: j.shortName,
    domainId: j.domainId,
    kind: "solana",
    network: net,
    color: j.color,
    logoChar: j.logoChar,
    supportedSource: j.supportedSource,
    explorerTxUrl: (h) => `${j.explorerTxBase}${h}${j.explorerTxSuffix ?? ""}`,
    solana: {
      rpcUrl: j.rpcUrl,
      usdcMint: j.usdcMint,
      tokenMessenger: j.tokenMessenger,
      messageTransmitter: j.messageTransmitter,
    },
  };
}

function buildChains(net: StellarNetwork): ChainInfo[] {
  const evmJson = (chainData.evm[net] ?? []) as JsonEvmChain[];
  const solanaJson = chainData.solana?.[net] as JsonSolanaChain | undefined;
  const stellarJson = chainData.stellar[net] as JsonStellarChain;
  const list: ChainInfo[] = [buildStellarChain(stellarJson, net)];
  for (const j of evmJson) list.push(buildEvmChain(j, net));
  if (solanaJson) list.push(buildSolanaChain(solanaJson, net));
  return list;
}

export const STELLAR_CHAIN: Record<StellarNetwork, ChainInfo> = {
  mainnet: buildStellarChain(chainData.stellar.mainnet as JsonStellarChain, "mainnet"),
  testnet: buildStellarChain(chainData.stellar.testnet as JsonStellarChain, "testnet"),
};

export const CHAINS_MAINNET: ChainInfo[] = buildChains("mainnet");
export const CHAINS_TESTNET: ChainInfo[] = buildChains("testnet");

export function chainsFor(network: StellarNetwork): ChainInfo[] {
  return network === "mainnet" ? CHAINS_MAINNET : CHAINS_TESTNET;
}

export function stellarChain(network: StellarNetwork): ChainInfo {
  return STELLAR_CHAIN[network];
}

// --- Token catalog ---

export interface TokenInfo {
  symbol: string;
  name: string;
  decimals: number;
  color: string;
  address?: string;
}

export function usdcForChain(chain: ChainInfo, network: StellarNetwork): TokenInfo {
  if (chain.kind === "stellar") {
    return {
      symbol: "USDC",
      name: "USD Coin",
      decimals: USDC_DECIMALS_STELLAR,
      color: "#2775CA",
      address: CCTP_CONFIGS[network].usdcContract,
    };
  }
  return {
    symbol: "USDC",
    name: "USD Coin",
    decimals: chain.kind === "solana" ? USDC_DECIMALS_SOLANA : USDC_DECIMALS_EVM,
    color: "#2775CA",
    address: chain.evm?.usdc ?? chain.solana?.usdcMint,
  };
}

export type DestChain = ChainInfo;

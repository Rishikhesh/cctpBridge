import {
  StellarWalletsKit,
  Networks,
} from "@creit.tech/stellar-wallets-kit";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import { FREIGHTER_ID } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import type { StellarNetwork } from "./cctp";

export interface ConnectedWallet {
  address: string;
}

let initialized = false;
let currentNetwork: StellarNetwork | null = null;

function networkEnum(net: StellarNetwork): Networks {
  return net === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

function ensureInit(network: StellarNetwork) {
  if (!initialized) {
    StellarWalletsKit.init({
      network: networkEnum(network),
      selectedWalletId: FREIGHTER_ID,
      modules: defaultModules(),
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

export async function openWalletModal(
  network: StellarNetwork,
): Promise<ConnectedWallet> {
  ensureInit(network);
  const { address } = await StellarWalletsKit.authModal();
  if (!address) throw new Error("No address returned from wallet");
  return { address };
}

export async function disconnectWallet(): Promise<void> {
  if (!initialized) return;
  try {
    await StellarWalletsKit.disconnect();
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

export async function signXdr(
  network: StellarNetwork,
  xdr: string,
  networkPassphrase: string,
  address: string,
): Promise<string> {
  ensureInit(network);
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
    networkPassphrase,
    address,
  });
  return signedTxXdr;
}

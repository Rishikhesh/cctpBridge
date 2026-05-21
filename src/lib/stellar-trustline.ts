import {
  Asset,
  Horizon,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { CCTP_CONFIGS, type StellarNetwork } from "./cctp";
import { signXdr } from "./wallet";

/**
 * Adds a USDC trustline on the given Stellar G-address using the connected
 * Stellar wallet. Required before EVM→Stellar via Forwarder can land —
 * mint_and_forward reverts if the recipient has no USDC trustline.
 *
 * Caller must already be the signer of `accountAddress` (i.e. that wallet
 * must be the currently-connected one in StellarWalletsKit).
 *
 * Returns the Horizon tx hash.
 */
export async function addUsdcTrustline(
  network: StellarNetwork,
  accountAddress: string,
): Promise<string> {
  const config = CCTP_CONFIGS[network];
  const server = new Horizon.Server(config.horizonUrl);
  const account = await server.loadAccount(accountAddress);

  const usdc = new Asset("USDC", config.usdcIssuer);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase:
      network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: usdc }))
    .setTimeout(180)
    .build();

  const signedXdr = await signXdr(
    network,
    tx.toXDR(),
    config.networkPassphrase,
    accountAddress,
  );
  const signed = TransactionBuilder.fromXDR(
    signedXdr,
    config.networkPassphrase,
  );
  const res = await server.submitTransaction(
    signed as Parameters<typeof server.submitTransaction>[0],
  );
  return res.hash;
}

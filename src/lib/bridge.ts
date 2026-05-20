import {
  Address,
  Contract,
  TransactionBuilder,
  rpc,
  xdr,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { isAddress, pad } from "viem";
import type { Hex } from "viem";
import { CCTP_CONFIGS, type StellarNetwork } from "./cctp";
import { getConnectedAddress, signXdr } from "./wallet";

const STELLAR_DOMAIN_FOR_SAFETY = 27;

export interface DepositForBurnParams {
  network: StellarNetwork;
  senderAddress: string;
  amount: bigint;
  destinationDomain: number;
  mintRecipientEvm: `0x${string}`;
  destinationCallerEvm?: `0x${string}` | null;
  maxFee: bigint;
  minFinalityThreshold: number;
}

export interface BridgeStepInfo {
  step: "approve" | "deposit" | "approved" | "submitted" | "confirmed";
  txHash?: string;
  message?: string;
}

export interface BridgeResult {
  approveTxHash: string;
  depositTxHash: string;
}

export function evmHexValid(addr: string): addr is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

function hexToBuffer(hex: string): Buffer {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("Invalid hex");
  return Buffer.from(clean, "hex");
}

function evmAddressToBytes32ScVal(evmAddr: string): xdr.ScVal {
  const normalized = (evmAddr.startsWith("0x") ? evmAddr : `0x${evmAddr}`) as Hex;
  if (!isAddress(normalized)) throw new Error(`Invalid EVM address: ${evmAddr}`);
  const padded = pad(normalized);
  return xdr.ScVal.scvBytes(hexToBuffer(padded));
}

async function submitContractCall(
  network: StellarNetwork,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  sender: string,
): Promise<string> {
  const config = CCTP_CONFIGS[network];
  const server = new rpc.Server(config.sorobanRpcUrl, { allowHttp: false });
  const account = await server.getAccount(sender);
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: "10000000",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(180)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }
  const prepared = rpc.assembleTransaction(tx, sim).build();
  const signedXdr = await signXdr(
    network,
    prepared.toXDR(),
    config.networkPassphrase,
    sender,
  );
  const signed = TransactionBuilder.fromXDR(signedXdr, config.networkPassphrase);
  const sendResult = await server.sendTransaction(signed as any);
  if (sendResult.status === "ERROR") {
    throw new Error(`Send failed: ${JSON.stringify(sendResult.errorResult)}`);
  }

  let getResult = await server.getTransaction(sendResult.hash);
  const start = Date.now();
  while (getResult.status === "NOT_FOUND") {
    if (Date.now() - start > 120_000) {
      throw new Error("Tx confirmation timeout");
    }
    await new Promise((r) => setTimeout(r, 2000));
    getResult = await server.getTransaction(sendResult.hash);
  }
  if (getResult.status !== "SUCCESS") {
    throw new Error(`Tx failed: ${getResult.status}`);
  }
  return sendResult.hash;
}

export async function mintAndForwardOnStellar(
  network: StellarNetwork,
  sender: string,
  messageHex: string,
  attestationHex: string,
): Promise<string> {
  if (!messageHex || !/^0x[0-9a-fA-F]+$/.test(messageHex))
    throw new Error(`[safety] message hex invalid`);
  if (!attestationHex || !/^0x[0-9a-fA-F]+$/.test(attestationHex))
    throw new Error(`[safety] attestation hex invalid`);
  const config = CCTP_CONFIGS[network];

  const live = await getConnectedAddress(network);
  if (!live || live !== sender) {
    throw new Error(
      `[safety] Stellar wallet account mismatch on mint_and_forward: expected ${sender}, got ${live ?? "none"}`,
    );
  }

  const args: xdr.ScVal[] = [
    xdr.ScVal.scvBytes(hexToBuffer(messageHex)),
    xdr.ScVal.scvBytes(hexToBuffer(attestationHex)),
  ];
  return submitContractCall(
    network,
    config.cctpForwarder,
    "mint_and_forward",
    args,
    sender,
  );
}

export async function executeDepositForBurn(
  params: DepositForBurnParams,
  onStep: (info: BridgeStepInfo) => void,
): Promise<BridgeResult> {
  const {
    network,
    senderAddress,
    amount,
    destinationDomain,
    mintRecipientEvm,
    destinationCallerEvm,
    maxFee,
    minFinalityThreshold,
  } = params;

  // Hard fund-safety invariants. Throw before any signature.
  if (amount <= 0n) throw new Error(`[safety] burn amount must be > 0`);
  if (maxFee < 0n) throw new Error(`[safety] maxFee must be >= 0`);
  if (maxFee > amount)
    throw new Error(`[safety] maxFee (${maxFee}) exceeds amount (${amount})`);
  if (![1000, 2000].includes(minFinalityThreshold))
    throw new Error(
      `[safety] minFinalityThreshold must be 1000 or 2000, got ${minFinalityThreshold}`,
    );
  if (!evmHexValid(mintRecipientEvm))
    throw new Error(`[safety] mintRecipientEvm not a valid EVM address: ${mintRecipientEvm}`);
  if (mintRecipientEvm.toLowerCase() === "0x0000000000000000000000000000000000000000")
    throw new Error(`[safety] mintRecipientEvm is zero address`);
  if (destinationCallerEvm && !evmHexValid(destinationCallerEvm))
    throw new Error(`[safety] destinationCallerEvm not a valid EVM address`);
  if (destinationDomain === STELLAR_DOMAIN_FOR_SAFETY)
    throw new Error(
      `[safety] destinationDomain is Stellar (27) — use EVM->Stellar Forwarder flow, not deposit_for_burn`,
    );

  const config = CCTP_CONFIGS[network];
  const server = new rpc.Server(config.sorobanRpcUrl, { allowHttp: false });

  // Verify wallet still tied to declared sender (no mid-flow account swap).
  const liveSender = await getConnectedAddress(network);
  if (!liveSender || liveSender !== senderAddress) {
    throw new Error(
      `[safety] Stellar wallet account mismatch: expected ${senderAddress}, got ${liveSender ?? "none"}. Aborting burn.`,
    );
  }

  // 1. approve
  onStep({ step: "approve" });
  const latestLedger = await server.getLatestLedger();
  const approveArgs: xdr.ScVal[] = [
    Address.fromString(senderAddress).toScVal(),
    Address.fromString(config.tokenMessengerMinter).toScVal(),
    nativeToScVal(amount, { type: "i128" }),
    nativeToScVal(latestLedger.sequence + 100_000, { type: "u32" }),
  ];
  const approveTxHash = await submitContractCall(
    network,
    config.usdcContract,
    "approve",
    approveArgs,
    senderAddress,
  );
  onStep({ step: "approved", txHash: approveTxHash });

  // 2. deposit_for_burn
  const destinationCallerScVal = destinationCallerEvm
    ? evmAddressToBytes32ScVal(destinationCallerEvm)
    : xdr.ScVal.scvBytes(Buffer.alloc(32));

  const depositArgs: xdr.ScVal[] = [
    Address.fromString(senderAddress).toScVal(),
    nativeToScVal(amount, { type: "i128" }),
    nativeToScVal(destinationDomain, { type: "u32" }),
    evmAddressToBytes32ScVal(mintRecipientEvm),
    Address.fromString(config.usdcContract).toScVal(),
    destinationCallerScVal,
    nativeToScVal(maxFee, { type: "i128" }),
    nativeToScVal(minFinalityThreshold, { type: "u32" }),
  ];

  onStep({ step: "deposit" });
  const depositTxHash = await submitContractCall(
    network,
    config.tokenMessengerMinter,
    "deposit_for_burn",
    depositArgs,
    senderAddress,
  );
  onStep({ step: "submitted", txHash: depositTxHash });
  onStep({ step: "confirmed", txHash: depositTxHash });

  return { approveTxHash, depositTxHash };
}

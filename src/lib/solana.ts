import {
  AnchorProvider,
  BN,
  Program,
  type Idl,
} from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  Transaction,
  type SendOptions,
  type TransactionInstruction,
  type ConfirmOptions,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { Buffer } from "buffer";
import bs58 from "bs58";
import MESSAGE_TRANSMITTER_V2_IDL from "@/data/idl/message_transmitter_v2.json";
import TOKEN_MESSENGER_MINTER_V2_IDL from "@/data/idl/token_messenger_minter_v2.json";
import type { ChainInfo } from "./cctp";

declare global {
  interface Window {
    solana?: PhantomProvider;
    phantom?: { solana?: PhantomProvider };
  }
}

interface PhantomSignAndSend {
  signature: string;
}

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string };
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString(): string } }>;
  disconnect: () => Promise<void>;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  signAllTransactions: (txs: Transaction[]) => Promise<Transaction[]>;
  signAndSendTransaction: (tx: Transaction, opts?: SendOptions) => Promise<PhantomSignAndSend>;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
  off?: (event: string, cb: (...args: unknown[]) => void) => void;
}

export function getSolanaProvider(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
  if (window.solana?.isPhantom) return window.solana;
  return null;
}

export function hasSolanaProvider(): boolean {
  return !!getSolanaProvider();
}

export async function solanaConnect(): Promise<string> {
  const p = getSolanaProvider();
  if (!p) throw new Error("Phantom (or compatible Solana) wallet not found.");
  const { publicKey } = await p.connect();
  return publicKey.toString();
}

export async function solanaDisconnect(): Promise<void> {
  const p = getSolanaProvider();
  if (!p) return;
  try {
    await p.disconnect();
  } catch {
    // ignore
  }
}

export async function solanaSilentConnect(): Promise<string | null> {
  const p = getSolanaProvider();
  if (!p) return null;
  try {
    const { publicKey } = await p.connect({ onlyIfTrusted: true });
    return publicKey.toString();
  } catch {
    return null;
  }
}

// =============== PDAs (replicates Circle's utilsV2.ts) ===============

function findPda(seedStr: string, programId: PublicKey, extraSeeds: (PublicKey | Buffer | string)[] = []) {
  const seeds: Buffer[] = [Buffer.from(seedStr)];
  for (const s of extraSeeds) {
    if (s instanceof PublicKey) seeds.push(s.toBuffer());
    else if (Buffer.isBuffer(s)) seeds.push(s);
    else if (typeof s === "string") seeds.push(Buffer.from(s));
    else throw new Error("unsupported seed");
  }
  const [pubkey, bump] = PublicKey.findProgramAddressSync(seeds, programId);
  return { publicKey: pubkey, bump };
}

function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex.replace(/^0x/, ""), "hex");
}

/** CCTP V2 message layout: nonce occupies bytes 12..44 */
export function decodeEventNonceFromMessageV2(messageHex: string): Buffer {
  const msg = hexToBytes(messageHex);
  if (msg.length < 44) throw new Error("[safety] CCTP message too short to decode nonce");
  return msg.subarray(12, 12 + 32);
}

// =============== Anchor wrapper ===============

// Anchor's Wallet type expects generic <T extends Transaction | VersionedTransaction>.
// We only sign legacy Transactions here; cast through unknown to satisfy the type.
interface AnchorLikeWallet {
  publicKey: PublicKey;
  signTransaction: <T>(tx: T) => Promise<T>;
  signAllTransactions: <T>(txs: T[]) => Promise<T[]>;
}

function phantomAsAnchorWallet(): AnchorLikeWallet {
  const p = getSolanaProvider();
  if (!p?.publicKey) throw new Error("Solana wallet not connected");
  const pk = new PublicKey(p.publicKey.toString());
  return {
    publicKey: pk,
    signTransaction: (async (tx: unknown) =>
      p.signTransaction(tx as Transaction)) as <T>(tx: T) => Promise<T>,
    signAllTransactions: (async (txs: unknown) =>
      p.signAllTransactions(txs as Transaction[])) as <T>(txs: T[]) => Promise<T[]>,
  };
}

interface SolanaPrograms {
  connection: Connection;
  messageTransmitter: Program<Idl>;
  tokenMessenger: Program<Idl>;
}

function getPrograms(chain: ChainInfo): SolanaPrograms {
  if (!chain.solana) throw new Error("Chain not Solana");
  const connection = new Connection(chain.solana.rpcUrl, { commitment: "confirmed" });
  const wallet = phantomAsAnchorWallet();
  const opts: ConfirmOptions = { commitment: "confirmed", preflightCommitment: "confirmed" };
  const provider = new AnchorProvider(connection, wallet, opts);

  const messageTransmitter = new Program<Idl>(
    MESSAGE_TRANSMITTER_V2_IDL as unknown as Idl,
    provider,
  );
  const tokenMessenger = new Program<Idl>(
    TOKEN_MESSENGER_MINTER_V2_IDL as unknown as Idl,
    provider,
  );
  return { connection, messageTransmitter, tokenMessenger };
}

interface ReceivePdas {
  messageTransmitterAccount: { publicKey: PublicKey; bump: number };
  tokenMessengerAccount: { publicKey: PublicKey; bump: number };
  tokenMinterAccount: { publicKey: PublicKey; bump: number };
  localToken: { publicKey: PublicKey; bump: number };
  remoteTokenMessengerKey: { publicKey: PublicKey; bump: number };
  remoteTokenKey: PublicKey;
  tokenPair: { publicKey: PublicKey; bump: number };
  custodyTokenAccount: { publicKey: PublicKey; bump: number };
  authorityPda: PublicKey;
  tokenMessengerEventAuthority: { publicKey: PublicKey; bump: number };
  usedNonce: PublicKey;
  feeRecipientTokenAccount: PublicKey;
}

async function getReceivePdas(
  programs: SolanaPrograms,
  solUsdcMint: PublicKey,
  remoteUsdcAddressHex: string,
  remoteDomain: number,
  nonce: Buffer,
): Promise<ReceivePdas> {
  const mtId = programs.messageTransmitter.programId;
  const tmId = programs.tokenMessenger.programId;

  const tokenMessengerAccount = findPda("token_messenger", tmId);
  const messageTransmitterAccount = findPda("message_transmitter", mtId);
  const tokenMinterAccount = findPda("token_minter", tmId);
  const localToken = findPda("local_token", tmId, [solUsdcMint]);
  const domainBuf = Buffer.alloc(4);
  domainBuf.writeUInt32BE(remoteDomain, 0);
  // Circle seeds remote_token_messenger by string-encoded domain id
  const remoteTokenMessengerKey = findPda(
    "remote_token_messenger",
    tmId,
    [String(remoteDomain)],
  );
  const remoteTokenKey = new PublicKey(
    // Solana addresses are 32 bytes; EVM USDC is 20 bytes left-padded
    Buffer.concat([Buffer.alloc(12), hexToBytes(remoteUsdcAddressHex)]),
  );
  const tokenPair = findPda("token_pair", tmId, [String(remoteDomain), remoteTokenKey]);
  const custodyTokenAccount = findPda("custody", tmId, [solUsdcMint]);
  const authorityPda = findPda("message_transmitter_authority", mtId, [tmId]).publicKey;
  const tokenMessengerEventAuthority = findPda("__event_authority", tmId);
  const usedNonce = findPda("used_nonce", mtId, [nonce]).publicKey;

  // feeRecipient is stored on the TokenMessenger account on-chain. Fetch it.
  // Use anchor account namespace if available
  type TokenMessengerAccountData = { feeRecipient: PublicKey };
  const tmAcct = (await (
    programs.tokenMessenger.account as unknown as {
      tokenMessenger: { fetch: (k: PublicKey) => Promise<TokenMessengerAccountData> };
    }
  ).tokenMessenger.fetch(tokenMessengerAccount.publicKey)) as TokenMessengerAccountData;
  const feeRecipientTokenAccount = await getAssociatedTokenAddress(
    solUsdcMint,
    tmAcct.feeRecipient,
  );

  return {
    messageTransmitterAccount,
    tokenMessengerAccount,
    tokenMinterAccount,
    localToken,
    remoteTokenMessengerKey,
    remoteTokenKey,
    tokenPair,
    custodyTokenAccount,
    authorityPda,
    tokenMessengerEventAuthority,
    usedNonce,
    feeRecipientTokenAccount,
  };
}

export interface SolanaReceiveParams {
  destChain: ChainInfo;             // dest Solana chain (mainnet or devnet)
  sourceChain: ChainInfo;           // EVM source (carries USDC hex for remote token)
  recipientPubkey: string;          // base58 Solana address (mintRecipient)
  messageHex: string;
  attestationHex: string;
}

export interface SolanaReceiveResult {
  signature: string;
}

export async function solanaReceiveMessage(
  params: SolanaReceiveParams,
): Promise<SolanaReceiveResult> {
  const { destChain, sourceChain, recipientPubkey, messageHex, attestationHex } = params;
  if (!destChain.solana) throw new Error("[safety] dest chain missing solana config");
  if (!sourceChain.evm) throw new Error("[safety] source chain missing evm config (need USDC hex)");

  // Validate basics
  if (!/^0x[0-9a-fA-F]+$/.test(messageHex)) throw new Error("[safety] message hex invalid");
  if (!/^0x[0-9a-fA-F]+$/.test(attestationHex)) throw new Error("[safety] attestation hex invalid");
  let recipient: PublicKey;
  try {
    recipient = new PublicKey(recipientPubkey);
  } catch {
    throw new Error(`[safety] invalid Solana recipient pubkey: ${recipientPubkey}`);
  }

  const programs = getPrograms(destChain);
  const wallet = phantomAsAnchorWallet();

  const solUsdcMint = new PublicKey(destChain.solana.usdcMint);
  const remoteUsdcAddressHex = sourceChain.evm.usdc;
  const remoteDomain = sourceChain.domainId;
  const nonce = decodeEventNonceFromMessageV2(messageHex);

  const pdas = await getReceivePdas(
    programs,
    solUsdcMint,
    remoteUsdcAddressHex,
    remoteDomain,
    nonce,
  );

  // Recipient's USDC ATA (must already exist — Circle's receive_message does
  // not create the recipient's ATA). We assert this and fail fast if missing.
  const userTokenAccount = await getAssociatedTokenAddress(solUsdcMint, recipient);
  const acct = await programs.connection.getAccountInfo(userTokenAccount);
  if (!acct) {
    throw new Error(
      `[safety] Recipient ${recipient.toBase58()} has no USDC associated token account (${userTokenAccount.toBase58()}). Create one (or fund with USDC once) before claiming, or transfer will revert.`,
    );
  }

  const remainingAccounts = [
    { pubkey: pdas.tokenMessengerAccount.publicKey, isSigner: false, isWritable: false },
    { pubkey: pdas.remoteTokenMessengerKey.publicKey, isSigner: false, isWritable: false },
    { pubkey: pdas.tokenMinterAccount.publicKey, isSigner: false, isWritable: true },
    { pubkey: pdas.localToken.publicKey, isSigner: false, isWritable: true },
    { pubkey: pdas.tokenPair.publicKey, isSigner: false, isWritable: false },
    { pubkey: pdas.feeRecipientTokenAccount, isSigner: false, isWritable: true },
    { pubkey: userTokenAccount, isSigner: false, isWritable: true },
    { pubkey: pdas.custodyTokenAccount.publicKey, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: pdas.tokenMessengerEventAuthority.publicKey, isSigner: false, isWritable: false },
    { pubkey: programs.tokenMessenger.programId, isSigner: false, isWritable: false },
  ];

  const methodBuilder = (
    programs.messageTransmitter.methods as unknown as {
      receiveMessage: (args: { message: Buffer; attestation: Buffer }) => {
        accounts: (a: Record<string, PublicKey>) => {
          remainingAccounts: (r: typeof remainingAccounts) => {
            instruction: () => Promise<TransactionInstruction>;
          };
        };
      };
    }
  ).receiveMessage({
    message: Buffer.from(messageHex.replace(/^0x/, ""), "hex"),
    attestation: Buffer.from(attestationHex.replace(/^0x/, ""), "hex"),
  });

  const ix = await methodBuilder
    .accounts({
      payer: wallet.publicKey,
      caller: wallet.publicKey,
      authorityPda: pdas.authorityPda,
      messageTransmitter: pdas.messageTransmitterAccount.publicKey,
      usedNonce: pdas.usedNonce,
      receiver: programs.tokenMessenger.programId,
      systemProgram: new PublicKey("11111111111111111111111111111111"),
    })
    .remainingAccounts(remainingAccounts)
    .instruction();

  // receive_message tx is account-heavy (~18 accounts + ~480-byte ix data) and
  // can already approach Solana's 1232-byte legacy tx limit. ComputeBudget
  // instructions would push us over. Default 200k CU is sufficient for
  // receive_message (matches Circle's reference example which sets no budget).
  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } =
    await programs.connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;

  // Pre-flight simulate — catches PDA mismatch, missing accounts, IDL drift
  // BEFORE the user signs. Legacy Transaction overload doesn't accept options.
  const sim = await programs.connection.simulateTransaction(tx);
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).join("\n");
    throw new Error(
      `[safety] Solana receive_message simulation failed: ${JSON.stringify(sim.value.err)}\n${logs}`,
    );
  }

  const phantom = getSolanaProvider();
  if (!phantom) throw new Error("Solana wallet not available");
  const { signature } = await phantom.signAndSendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 5,
  });

  // Sanity: lastValidBlockHeight not actively used by getSignatureStatuses
  // loop, but log it via the deadline check below so the value is read.
  void lastValidBlockHeight;

  // Manual long-poll of signature status. confirmTransaction({blockhash})
  // bails the moment the blockhash window expires (~60s) even when the tx is
  // still landing — that's the "block height exceeded" error users see.
  // getSignatureStatuses tells us the truth: landed or not.
  const deadline = Date.now() + 180_000; // 3 minutes
  while (Date.now() < deadline) {
    const { value } = await programs.connection.getSignatureStatuses(
      [signature],
      { searchTransactionHistory: true },
    );
    const st = value[0];
    if (st) {
      if (st.err) {
        throw new Error(
          `Solana receive_message reverted: ${JSON.stringify(st.err)}`,
        );
      }
      if (
        st.confirmationStatus === "confirmed" ||
        st.confirmationStatus === "finalized"
      ) {
        return { signature };
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `Solana tx ${signature} not confirmed within 3 minutes. Check Solscan; it may still land.`,
  );
}

export async function solanaUsdcBalance(
  chain: ChainInfo,
  owner: string,
): Promise<bigint> {
  if (!chain.solana) throw new Error("Chain not Solana");
  const connection = new Connection(chain.solana.rpcUrl, "confirmed");
  let ownerPk: PublicKey;
  try {
    ownerPk = new PublicKey(owner);
  } catch {
    return 0n;
  }
  const ata = await getAssociatedTokenAddress(new PublicKey(chain.solana.usdcMint), ownerPk);
  const info = await connection.getTokenAccountBalance(ata).catch(() => null);
  return info?.value?.amount ? BigInt(info.value.amount) : 0n;
}

export function isValidSolanaAddress(addr: string): boolean {
  try {
    new PublicKey(addr);
    // also reject obviously malformed strings
    return bs58.decode(addr).length === 32;
  } catch {
    return false;
  }
}

// avoid unused import elimination
void BN;

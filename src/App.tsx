import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  Copy,
  ExternalLink,
  Info,
  Loader2,
  LogOut,
  RefreshCw,
  Wallet,
  Zap,
} from "lucide-react";
import { Modal } from "@/components/Modal";
import { StellarWalletPicker } from "@/components/StellarWalletPicker";
import { EvmWalletPicker } from "@/components/EvmWalletPicker";
import { useTheme } from "@/hooks/useTheme";
import { Moon, Sun } from "lucide-react";
import {
  CCTP_CONFIGS,
  STELLAR_DOMAIN_ID,
  USDC_DECIMALS_CCTP,
  USDC_DECIMALS_EVM,
  USDC_DECIMALS_STELLAR,
  chainsFor,
  usdcForChain,
  type ChainInfo,
  type ChainKind,
  type StellarNetwork,
} from "@/lib/cctp";
import {
  cctpEtaSeconds,
  computeMaxFee,
  fetchBurnFees,
  pollAttestation,
  type AttestationStatusUpdate,
  type BurnFee,
  type CctpAttestation,
} from "@/lib/attestation";
import { fetchStellarBalances, type StellarBalances } from "@/lib/balance";
import { addUsdcTrustline } from "@/lib/stellar-trustline";
import {
  evmHexValid,
  executeDepositForBurn,
  mintAndForwardOnStellar,
  type BridgeStepInfo,
} from "@/lib/bridge";
import {
  callReceiveMessage,
  evmApproveUsdc,
  evmDepositForBurn,
  fetchEvmUsdcAllowance,
  fetchEvmUsdcBalance,
  waitForReceipt,
} from "@/lib/evm";
import {
  assertHookDataRoundtrip,
  buildCctpForwarderHookData,
  contractStrkeyToBytes32,
  isValidStellarRecipient,
  stellarRecipientKind,
} from "@/lib/stellar-utils";
import {
  cn,
  formatError,
  formatUsdc,
  formatUsdcFixed,
  parseUsdc,
  shortAddr,
} from "@/lib/utils";
import { useWallet } from "@/hooks/useWallet";
import { useEvmWallet } from "@/hooks/useEvmWallet";
import { useSolanaWallet } from "@/hooks/useSolanaWallet";
import { isValidSolanaAddress, solanaReceiveMessage } from "@/lib/solana";
import { PublicKey as SolanaPublicKey, Connection as SolanaConnection } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { ChainPicker, TokenChip } from "@/components/ChainPicker";
import { ChainLogo } from "@/components/ChainLogo";
import {
  StatusTimeline,
  type TimelineStep,
} from "@/components/StatusTimeline";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

type Speed = "fast" | "standard";

type Phase =
  | "idle"
  | "approving"
  | "burning"
  | "attesting"
  | "minting"
  | "done"
  | "error";

interface ProgressState {
  phase: Phase;
  approveTx?: string;
  burnTx?: string;
  mintTx?: string;
  attestation?: CctpAttestation;
  pollAttempts: number;
  irisStatus?: string;
  finalityThresholdExecuted?: number;
  feeExecutedSubunits?: string;
  attestStartedAt?: number;
  etaSeconds?: number;
  error?: string;
  // Snapshot of the transfer at burn-start, so the status header is stable
  // even if the user edits the form mid-flight.
  sendAmount?: string;          // human-readable, source decimals
  receiveAmount?: string;       // human-readable, dest decimals
  fromName?: string;
  toName?: string;
  fromShort?: string;
  toShort?: string;
}

const INIT_PROGRESS: ProgressState = { phase: "idle", pollAttempts: 0 };

type Direction =
  | "stellar->evm"
  | "evm->stellar"
  | "evm->evm"
  | "evm->solana";

function detectDirection(from: ChainInfo, to: ChainInfo): Direction | null {
  if (from.kind === "stellar" && to.kind === "evm") return "stellar->evm";
  if (from.kind === "evm" && to.kind === "stellar") return "evm->stellar";
  if (from.kind === "evm" && to.kind === "evm") return "evm->evm";
  if (from.kind === "evm" && to.kind === "solana") return "evm->solana";
  return null;
}

function App() {
  const stellarWallet = useWallet();
  const evmWallet = useEvmWallet();
  const solanaWallet = useSolanaWallet();
  const themeCtl = useTheme();
  const { network, setNetwork } = stellarWallet;
  const config = CCTP_CONFIGS[network];
  const allChains = useMemo(() => chainsFor(network), [network]);

  const defaultFromTo = useCallback(
    (net: StellarNetwork): { from: ChainInfo; to: ChainInfo } => {
      const list = chainsFor(net);
      const ethId = net === "mainnet" ? "ethereum-mainnet" : "ethereum-sepolia";
      const baseId = net === "mainnet" ? "base-mainnet" : "base-sepolia";
      const eth = list.find((c) => c.id === ethId) ?? list[1];
      const base = list.find((c) => c.id === baseId) ?? list[2];
      return { from: eth, to: base };
    },
    [],
  );

  const initial = defaultFromTo(network);
  const [fromChain, setFromChain] = useState<ChainInfo>(initial.from);
  const [toChain, setToChain] = useState<ChainInfo>(initial.to);

  useEffect(() => {
    const next = defaultFromTo(network);
    setFromChain(next.from);
    setToChain(next.to);
  }, [network, defaultFromTo]);

  const direction = useMemo(
    () => detectDirection(fromChain, toChain),
    [fromChain, toChain],
  );
  const supported = direction !== null && fromChain.supportedSource;

  const fromToken = usdcForChain(fromChain, network);
  const toToken = usdcForChain(toChain, network);
  const fromDecimals = fromToken.decimals;

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [speed, setSpeed] = useState<Speed>("fast");
  const [fees, setFees] = useState<{ fast: BurnFee; slow: BurnFee } | null>(null);
  const [feesLoading, setFeesLoading] = useState(false);
  const [feesEpoch, setFeesEpoch] = useState(0);

  const [stellarBalances, setStellarBalances] = useState<StellarBalances | null>(null);
  const [stellarBalLoading, setStellarBalLoading] = useState(false);
  const [evmBalance, setEvmBalance] = useState<bigint | null>(null);
  const [evmBalLoading, setEvmBalLoading] = useState(false);

  const [bridging, setBridging] = useState(false);
  const [progress, setProgress] = useState<ProgressState>(INIT_PROGRESS);
  const [progressOpen, setProgressOpen] = useState(false);
  const [contractsOpen, setContractsOpen] = useState(false);
  const [swapKick, setSwapKick] = useState(0);
  const [addingTrustline, setAddingTrustline] = useState(false);
  const pollAbort = useRef<AbortController | null>(null);

  // Wallet address per chain kind. Single source of truth for both source
  // and destination resolution — keeps Recipient locked to a connected wallet.
  const walletAddressFor = useCallback(
    (kind: ChainKind): string | null => {
      switch (kind) {
        case "evm":
          return evmWallet.address;
        case "stellar":
          return stellarWallet.address;
        case "solana":
          return solanaWallet.address;
        default:
          return null;
      }
    },
    [evmWallet.address, stellarWallet.address, solanaWallet.address],
  );

  const connectWalletFor = useCallback(
    async (kind: ChainKind): Promise<void> => {
      switch (kind) {
        case "evm":
          await evmWallet.connect();
          return;
        case "stellar":
          await stellarWallet.connect();
          return;
        case "solana":
          await solanaWallet.connect();
          return;
      }
    },
    [evmWallet, stellarWallet, solanaWallet],
  );

  const connectingWalletFor = useCallback(
    (kind: ChainKind): boolean => {
      switch (kind) {
        case "evm":
          return evmWallet.connecting;
        case "stellar":
          return stellarWallet.connecting;
        case "solana":
          return solanaWallet.connecting;
        default:
          return false;
      }
    },
    [evmWallet.connecting, stellarWallet.connecting, solanaWallet.connecting],
  );

  // Recipient defaults to the destination wallet's connected address. User
  // can opt-in to manual entry via `useCustomRecipient`. Manual entry still
  // runs all pre-burn safety checks (EVM zero, Stellar trustline, Solana ATA).
  const [useCustomRecipient, setUseCustomRecipient] = useState(false);

  useEffect(() => {
    if (useCustomRecipient) return;
    setRecipient(walletAddressFor(toChain.kind) ?? "");
  }, [toChain.id, toChain.kind, walletAddressFor, useCustomRecipient]);

  // Reset to wallet-locked mode whenever the destination chain changes.
  useEffect(() => {
    setUseCustomRecipient(false);
  }, [toChain.id]);

  // Source balance loader
  const loadStellarBalance = useCallback(async () => {
    if (!stellarWallet.address || fromChain.kind !== "stellar") return;
    setStellarBalLoading(true);
    try {
      const b = await fetchStellarBalances(
        config.horizonUrl,
        stellarWallet.address,
        config.usdcIssuer,
      );
      setStellarBalances(b);
    } finally {
      setStellarBalLoading(false);
    }
  }, [stellarWallet.address, fromChain.kind, config.horizonUrl, config.usdcIssuer]);

  const loadEvmBalance = useCallback(async () => {
    if (!evmWallet.address || fromChain.kind !== "evm" || !fromChain.evm) return;
    setEvmBalLoading(true);
    try {
      const b = await fetchEvmUsdcBalance(fromChain, evmWallet.address as `0x${string}`);
      setEvmBalance(b);
    } catch {
      setEvmBalance(null);
    } finally {
      setEvmBalLoading(false);
    }
  }, [evmWallet.address, fromChain]);

  useEffect(() => {
    if (fromChain.kind === "stellar") loadStellarBalance();
    if (fromChain.kind === "evm") loadEvmBalance();
  }, [fromChain.id, loadStellarBalance, loadEvmBalance]);

  // Fees source→dest
  useEffect(() => {
    let aborted = false;
    const controller = new AbortController();
    setFeesLoading(true);
    fetchBurnFees(config.irisApiUrl, fromChain.domainId, toChain.domainId, controller.signal)
      .then((f) => {
        if (!aborted) setFees(f);
      })
      .catch(() => {
        if (!aborted) setFees(null);
      })
      .finally(() => {
        if (!aborted) setFeesLoading(false);
      });
    return () => {
      aborted = true;
      controller.abort();
    };
  }, [config.irisApiUrl, fromChain.domainId, toChain.domainId, feesEpoch]);

  const refreshFees = useCallback(() => setFeesEpoch((e) => e + 1), []);

  const parsedAmount = useMemo(() => {
    try {
      if (!amount) return 0n;
      return parseUsdc(amount, fromDecimals);
    } catch {
      return null;
    }
  }, [amount, fromDecimals]);

  // CCTP canonical 6-dec amount
  const cctpAmount = useMemo(() => {
    if (parsedAmount === null) return 0n;
    if (fromDecimals > USDC_DECIMALS_CCTP) {
      return parsedAmount / 10n ** BigInt(fromDecimals - USDC_DECIMALS_CCTP);
    }
    return parsedAmount;
  }, [parsedAmount, fromDecimals]);

  const activeFee = speed === "fast" ? fees?.fast : fees?.slow;
  const maxFee = useMemo(() => {
    if (!activeFee) return 0n;
    return computeMaxFee(cctpAmount, activeFee.minimumFee);
  }, [activeFee, cctpAmount]);
  const receiveAmount = cctpAmount > maxFee ? cctpAmount - maxFee : 0n;

  const sourceBalanceRaw =
    fromChain.kind === "stellar" ? stellarBalances?.usdcRaw ?? 0n : evmBalance ?? 0n;
  const sourceBalLoading =
    fromChain.kind === "stellar" ? stellarBalLoading : evmBalLoading;
  const sourceBalDisplay = useMemo(() => {
    if (fromChain.kind === "stellar" && stellarBalances)
      return Number(stellarBalances.usdc).toLocaleString(undefined, { maximumFractionDigits: 4 });
    if (fromChain.kind === "evm" && evmBalance !== null)
      return Number(formatUsdc(evmBalance, USDC_DECIMALS_EVM)).toLocaleString(undefined, {
        maximumFractionDigits: 4,
      });
    return null;
  }, [fromChain.kind, stellarBalances, evmBalance]);

  const amountInvalid = amount.length > 0 && parsedAmount === null;
  const recipientInvalid = useMemo(() => {
    if (!recipient) return false;
    if (toChain.kind === "evm") return !evmHexValid(recipient);
    if (toChain.kind === "stellar") return !isValidStellarRecipient(recipient);
    if (toChain.kind === "solana") return !isValidSolanaAddress(recipient);
    return false;
  }, [recipient, toChain.kind]);

  const insufficient =
    parsedAmount !== null &&
    sourceBalanceRaw > 0n &&
    parsedAmount > sourceBalanceRaw;

  const sourceWalletAddress = walletAddressFor(fromChain.kind);
  const destWalletAddress = walletAddressFor(toChain.kind);

  const canBridge =
    supported &&
    !!parsedAmount &&
    parsedAmount > 0n &&
    !amountInvalid &&
    !!recipient &&
    !recipientInvalid &&
    !insufficient &&
    !!fees &&
    !bridging;

  const handleMax = () => {
    if (sourceBalanceRaw > 0n) setAmount(formatUsdc(sourceBalanceRaw, fromDecimals));
  };

  const handleSwap = () => {
    if (!toChain.supportedSource) return;
    setSwapKick((k) => k + 1);
    const a = fromChain;
    setFromChain(toChain);
    setToChain(a);
  };

  const resetProgress = () => {
    pollAbort.current?.abort();
    pollAbort.current = null;
    setProgress(INIT_PROGRESS);
  };

  /** Wipes all in-flight bridge state. Called when any wallet disconnects so
   * a previous half-flow can't bleed into a new connection. */
  const resetBridgeState = useCallback(() => {
    pollAbort.current?.abort();
    pollAbort.current = null;
    setProgress(INIT_PROGRESS);
    setProgressOpen(false);
    setAmount("");
    setRecipient("");
    setStellarBalances(null);
    setEvmBalance(null);
  }, []);

  // Reset bridge state when any wallet flips from connected → disconnected,
  // BUT never while a bridge is in-flight — during Stellar→EVM (and similar)
  // the user is asked to connect the dest wallet mid-flow, which auto-evicts
  // the source WC session; that's expected and must not abort the bridge.
  const prevConnectedRef = useRef({
    stellar: !!stellarWallet.address,
    evm: !!evmWallet.address,
    solana: !!solanaWallet.address,
  });
  useEffect(() => {
    const cur = {
      stellar: !!stellarWallet.address,
      evm: !!evmWallet.address,
      solana: !!solanaWallet.address,
    };
    const prev = prevConnectedRef.current;
    const droppedAny =
      (prev.stellar && !cur.stellar) ||
      (prev.evm && !cur.evm) ||
      (prev.solana && !cur.solana);
    if (droppedAny && !bridging) resetBridgeState();
    prevConnectedRef.current = cur;
  }, [
    stellarWallet.address,
    evmWallet.address,
    solanaWallet.address,
    bridging,
    resetBridgeState,
  ]);

  // === Bridge flows ===

  // Refs that always hold the LATEST wallet state, so async bridge code can
  // wait for connection without being stuck on a stale closure value.
  const stellarAddrRef = useRef(stellarWallet.address);
  const evmAddrRef = useRef(evmWallet.address);
  const solanaAddrRef = useRef(solanaWallet.address);
  const evmChainIdRef = useRef(evmWallet.chainId);
  useEffect(() => {
    stellarAddrRef.current = stellarWallet.address;
  }, [stellarWallet.address]);
  useEffect(() => {
    evmAddrRef.current = evmWallet.address;
  }, [evmWallet.address]);
  useEffect(() => {
    solanaAddrRef.current = solanaWallet.address;
  }, [solanaWallet.address]);
  useEffect(() => {
    evmChainIdRef.current = evmWallet.chainId;
  }, [evmWallet.chainId]);

  const PICK_TIMEOUT_MS = 5 * 60 * 1000;

  async function pollUntil<T>(
    getter: () => T | null | undefined,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = getter();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`${label} not connected within ${timeoutMs / 1000}s`);
  }

  async function ensureStellarConnected(): Promise<string> {
    if (stellarAddrRef.current) return stellarAddrRef.current;
    await stellarWallet.connect();
    return pollUntil(() => stellarAddrRef.current, PICK_TIMEOUT_MS, "Stellar wallet");
  }

  async function ensureEvmConnected(): Promise<string> {
    if (evmAddrRef.current) return evmAddrRef.current;
    await evmWallet.connect();
    return pollUntil(() => evmAddrRef.current, PICK_TIMEOUT_MS, "EVM wallet");
  }

  async function ensureSolanaConnected(): Promise<string> {
    if (solanaAddrRef.current) return solanaAddrRef.current;
    await solanaWallet.connect();
    return pollUntil(() => solanaAddrRef.current, PICK_TIMEOUT_MS, "Solana wallet");
  }

  async function ensureEvmOnChain(chain: ChainInfo) {
    if (!chain.evm) throw new Error("Chain not EVM");
    if (evmChainIdRef.current !== chain.evm.chainId) {
      await evmWallet.switchToChain(chain);
    }
  }

  // Show "Add trustline + retry" button only when:
  //   - the error is the missing-trustline safety throw
  //   - direction is EVM→Stellar
  //   - recipient equals the user's CURRENTLY connected Stellar wallet
  //     (we can only sign a trustline op on accounts we control)
  const canFixTrustline = useMemo(() => {
    if (!progress.error) return false;
    if (!/no USDC trustline|verify USDC trustline/i.test(progress.error)) return false;
    if (direction !== "evm->stellar") return false;
    if (!stellarWallet.address) return false;
    return recipient === stellarWallet.address;
  }, [progress.error, direction, recipient, stellarWallet.address]);

  const handleAddTrustline = useCallback(async () => {
    if (!stellarWallet.address) return;
    setAddingTrustline(true);
    try {
      await addUsdcTrustline(network, stellarWallet.address);
      // Clear the failure state + re-trigger bridge.
      setProgress(INIT_PROGRESS);
    } catch (e) {
      setProgress((p) => ({ ...p, error: formatError(e, "Add trustline failed") }));
    } finally {
      setAddingTrustline(false);
    }
  }, [stellarWallet.address, network]);

  /**
   * Runs only the destination-side mint using an existing attestation +
   * destination chain. Called from the main flow AND from the "Retry mint"
   * button when the mint step fails after burn+attestation succeeded — burn
   * is irreversible so users must be able to re-attempt the mint without
   * burning again. CCTP allows safe replay of receiveMessage as long as the
   * nonce isn't already used.
   */
  const executeMintStep = useCallback(
    async (args: {
      dir: Direction;
      destChain: ChainInfo;
      srcChain: ChainInfo;
      recipientAddr: string;
      attestation: CctpAttestation;
    }): Promise<{ mintTx: string }> => {
      const { dir, destChain, srcChain, recipientAddr, attestation } = args;
      setProgress((p) => ({ ...p, phase: "minting", error: undefined }));

      if (dir === "stellar->evm" || dir === "evm->evm") {
        const evmAddr = await ensureEvmConnected();
        await ensureEvmOnChain(destChain);
        const tx = await callReceiveMessage(
          destChain,
          evmAddr as `0x${string}`,
          attestation.message,
          attestation.attestation,
        );
        setProgress((p) => ({ ...p, mintTx: tx.txHash, phase: "minting" }));
        const status = await waitForReceipt(destChain, tx.txHash);
        if (status !== "success")
          throw new Error("Destination receiveMessage reverted");
        setProgress((p) => ({ ...p, mintTx: tx.txHash, phase: "done" }));
        return { mintTx: tx.txHash };
      }

      if (dir === "evm->stellar") {
        const stellarAddr = await ensureStellarConnected();
        const mintTx = await mintAndForwardOnStellar(
          network,
          stellarAddr,
          attestation.message,
          attestation.attestation,
        );
        setProgress((p) => ({ ...p, mintTx, phase: "done" }));
        return { mintTx };
      }

      if (dir === "evm->solana") {
        await ensureSolanaConnected();
        const { signature } = await solanaReceiveMessage({
          destChain,
          sourceChain: srcChain,
          recipientPubkey: recipientAddr,
          messageHex: attestation.message,
          attestationHex: attestation.attestation,
        });
        setProgress((p) => ({ ...p, mintTx: signature, phase: "done" }));
        return { mintTx: signature };
      }

      throw new Error(`Unknown direction: ${dir}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [network],
  );

  // "Retry mint" — available when burn+attestation succeeded but mint reverted
  // or the user closed the modal mid-mint. Same recipient + chains as before;
  // attestation reused. CCTP MessageTransmitter rejects already-used nonces,
  // so replay is safe.
  const canRetryMint = useMemo(() => {
    return (
      !!progress.attestation &&
      !!progress.burnTx &&
      !progress.mintTx &&
      !bridging &&
      !!direction
    );
  }, [progress.attestation, progress.burnTx, progress.mintTx, bridging, direction]);

  const handleRetryMint = useCallback(async () => {
    if (!progress.attestation || !direction) return;
    setBridging(true);
    setProgressOpen(true);
    try {
      await executeMintStep({
        dir: direction,
        destChain: toChain,
        srcChain: fromChain,
        recipientAddr: recipient,
        attestation: progress.attestation,
      });
    } catch (e) {
      setProgress((p) => ({
        ...p,
        phase: "error",
        error: formatError(e, "Retry mint failed"),
      }));
    } finally {
      setBridging(false);
    }
  }, [
    progress.attestation,
    direction,
    toChain,
    fromChain,
    recipient,
    executeMintStep,
  ]);

  const handleBridge = async () => {
    if (!direction || !activeFee || parsedAmount === null) return;
    resetProgress();
    setBridging(true);
    setProgressOpen(true);
    // Snapshot quote values so the status header doesn't shift if the user
    // edits the form mid-flight.
    const destDecimalsLocal =
      toChain.kind === "stellar" ? USDC_DECIMALS_STELLAR : USDC_DECIMALS_CCTP;
    const destReceiveLocal =
      toChain.kind === "stellar"
        ? receiveAmount * 10n ** BigInt(USDC_DECIMALS_STELLAR - USDC_DECIMALS_CCTP)
        : receiveAmount;
    setProgress((p) => ({
      ...p,
      sendAmount: formatUsdc(parsedAmount, fromDecimals),
      receiveAmount: formatUsdc(destReceiveLocal, destDecimalsLocal),
      fromName: fromChain.name,
      toName: toChain.name,
      fromShort: fromChain.shortName,
      toShort: toChain.shortName,
    }));

    try {
      if (direction === "stellar->evm") {
        const sender = await ensureStellarConnected();

        // Safety: dest must be EVM with addr + non-zero
        if (toChain.kind !== "evm" || !toChain.evm)
          throw new Error(`[safety] toChain not EVM`);
        if (!evmHexValid(recipient))
          throw new Error(`[safety] EVM recipient invalid`);
        if (recipient.toLowerCase() === "0x0000000000000000000000000000000000000000")
          throw new Error(`[safety] EVM recipient is zero address`);
        if (fromChain.domainId === toChain.domainId)
          throw new Error(`[safety] self-bridge refused (same domain)`);
        // Stellar 7th decimal is truncated by CCTP (canonical = 6-dec). Silent dust.

        const onStep = (info: BridgeStepInfo) => {
          if (info.step === "approve") setProgress((p) => ({ ...p, phase: "approving" }));
          if (info.step === "approved" && info.txHash)
            setProgress((p) => ({ ...p, approveTx: info.txHash, phase: "burning" }));
          if (info.step === "submitted" && info.txHash)
            setProgress((p) => ({ ...p, burnTx: info.txHash, phase: "burning" }));
          if (info.step === "confirmed" && info.txHash)
            setProgress((p) => ({ ...p, burnTx: info.txHash, phase: "attesting" }));
        };

        const result = await executeDepositForBurn(
          {
            network,
            senderAddress: sender,
            amount: parsedAmount,
            destinationDomain: toChain.domainId,
            mintRecipientEvm: recipient as `0x${string}`,
            maxFee,
            minFinalityThreshold: activeFee.finalityThreshold,
          },
          onStep,
        );

        setProgress((p) => ({
          ...p,
          attestStartedAt: Date.now(),
          etaSeconds: cctpEtaSeconds(fromChain.domainId, activeFee.finalityThreshold),
        }));
        const controller = new AbortController();
        pollAbort.current = controller;
        const attestation = await pollAttestation(
          config.irisApiUrl,
          fromChain.domainId,
          result.depositTxHash,
          {
            signal: controller.signal,
            onPoll: (u: AttestationStatusUpdate) =>
              setProgress((p) => ({
                ...p,
                pollAttempts: u.attempt,
                irisStatus: u.status,
                finalityThresholdExecuted: u.finalityThresholdExecuted,
                feeExecutedSubunits: u.feeExecuted,
              })),
          },
        );
        setProgress((p) => ({ ...p, attestation, phase: "minting" }));

        // Auto-claim on EVM destination
        const evmAddr = await ensureEvmConnected();
        await ensureEvmOnChain(toChain);
        const mintTx = await callReceiveMessage(
          toChain,
          evmAddr as `0x${string}`,
          attestation.message,
          attestation.attestation,
        );
        setProgress((p) => ({ ...p, mintTx: mintTx.txHash, phase: "minting" }));
        const status = await waitForReceipt(toChain, mintTx.txHash);
        if (status !== "success") throw new Error("Destination tx reverted");
        setProgress((p) => ({ ...p, mintTx: mintTx.txHash, phase: "done" }));
      }

      if (direction === "evm->evm") {
        const sender = await ensureEvmConnected();
        await ensureEvmOnChain(fromChain);

        // Sanity: recipient validates as EVM, not zero
        if (!evmHexValid(recipient))
          throw new Error(`[safety] EVM recipient invalid`);
        if (recipient.toLowerCase() === "0x0000000000000000000000000000000000000000")
          throw new Error(`[safety] EVM recipient is zero address`);
        if (toChain.kind !== "evm" || !toChain.evm)
          throw new Error(`[safety] toChain not EVM`);
        if (fromChain.domainId === toChain.domainId)
          throw new Error(`[safety] fromDomain == toDomain — refusing self-bridge`);

        // Approve if needed
        setProgress((p) => ({ ...p, phase: "approving" }));
        const allowance = await fetchEvmUsdcAllowance(fromChain, sender as `0x${string}`);
        if (allowance < parsedAmount) {
          const approveTx = await evmApproveUsdc(
            fromChain,
            sender as `0x${string}`,
            parsedAmount,
          );
          setProgress((p) => ({ ...p, approveTx, phase: "approving" }));
          const s = await waitForReceipt(fromChain, approveTx);
          if (s !== "success") throw new Error("Approve reverted");
        }

        // Burn
        setProgress((p) => ({ ...p, phase: "burning" }));
        const mintRecipientBytes32 = `0x${(recipient as string).slice(2).padStart(64, "0")}` as `0x${string}`;
        const burnHash = await evmDepositForBurn(fromChain, sender as `0x${string}`, {
          amount: parsedAmount,
          destinationDomain: toChain.domainId,
          mintRecipient: mintRecipientBytes32,
          burnToken: fromChain.evm!.usdc,
          destinationCaller: `0x${"00".repeat(32)}` as `0x${string}`,
          maxFee,
          minFinalityThreshold: activeFee.finalityThreshold,
        });
        setProgress((p) => ({ ...p, burnTx: burnHash, phase: "burning" }));
        const burnStatus = await waitForReceipt(fromChain, burnHash);
        if (burnStatus !== "success") throw new Error("Burn reverted");
        setProgress((p) => ({
          ...p,
          burnTx: burnHash,
          phase: "attesting",
          attestStartedAt: Date.now(),
          etaSeconds: cctpEtaSeconds(fromChain.domainId, activeFee.finalityThreshold),
        }));

        const controller = new AbortController();
        pollAbort.current = controller;
        const attestation = await pollAttestation(
          config.irisApiUrl,
          fromChain.domainId,
          burnHash,
          {
            signal: controller.signal,
            onPoll: (u) =>
              setProgress((p) => ({
                ...p,
                pollAttempts: u.attempt,
                irisStatus: u.status,
                finalityThresholdExecuted: u.finalityThresholdExecuted,
                feeExecutedSubunits: u.feeExecuted,
              })),
          },
        );
        setProgress((p) => ({ ...p, attestation, phase: "minting" }));

        await ensureEvmOnChain(toChain);
        const mintTx = await callReceiveMessage(
          toChain,
          sender as `0x${string}`,
          attestation.message,
          attestation.attestation,
        );
        setProgress((p) => ({ ...p, mintTx: mintTx.txHash, phase: "minting" }));
        const ms = await waitForReceipt(toChain, mintTx.txHash);
        if (ms !== "success") throw new Error("Destination tx reverted");
        setProgress((p) => ({ ...p, mintTx: mintTx.txHash, phase: "done" }));
      }

      if (direction === "evm->solana") {
        const sender = await ensureEvmConnected();
        await ensureEvmOnChain(fromChain);

        // Safety: validate Solana recipient + dest config
        if (!isValidSolanaAddress(recipient))
          throw new Error(`[safety] Solana recipient invalid: ${recipient}`);
        if (toChain.kind !== "solana" || !toChain.solana)
          throw new Error(`[safety] toChain not Solana`);
        if (toChain.domainId !== 5)
          throw new Error(`[safety] Solana domain must be 5, got ${toChain.domainId}`);

        // CCTP V2 on Solana: mintRecipient encoded in the burn message is the
        // recipient's USDC **associated token account (ATA)** — NOT the wallet
        // pubkey. The Solana program asserts `userTokenAccount == mintRecipient`.
        const recipientPk = new SolanaPublicKey(recipient);
        const usdcMintPk = new SolanaPublicKey(toChain.solana.usdcMint);
        const recipientAta = await getAssociatedTokenAddress(usdcMintPk, recipientPk);
        const mintRecipientBytes32 = `0x${recipientAta.toBuffer().toString("hex")}` as `0x${string}`;
        if (mintRecipientBytes32.length !== 66)
          throw new Error(`[safety] Solana mintRecipient not bytes32`);

        // ATA must exist BEFORE burn — receive_message does not create it.
        // Burning into a non-existent ATA leaves attestation unredeemable
        // until the user (or anyone) creates the ATA. Verify now and abort.
        const solConn = new SolanaConnection(toChain.solana.rpcUrl, "confirmed");
        const ataInfo = await solConn.getAccountInfo(recipientAta);
        if (!ataInfo) {
          throw new Error(
            `[safety] Recipient ${recipient} has no USDC associated token account on Solana (${recipientAta.toBase58()}). Send any USDC to ${recipient} once to create it, then retry.`,
          );
        }

        // Approve if needed
        setProgress((p) => ({ ...p, phase: "approving" }));
        const allowance = await fetchEvmUsdcAllowance(fromChain, sender as `0x${string}`);
        if (allowance < parsedAmount) {
          const approveTx = await evmApproveUsdc(
            fromChain,
            sender as `0x${string}`,
            parsedAmount,
          );
          setProgress((p) => ({ ...p, approveTx, phase: "approving" }));
          const s = await waitForReceipt(fromChain, approveTx);
          if (s !== "success") throw new Error("Approve reverted");
        }

        // Burn
        setProgress((p) => ({ ...p, phase: "burning" }));
        const burnHash = await evmDepositForBurn(fromChain, sender as `0x${string}`, {
          amount: parsedAmount,
          destinationDomain: toChain.domainId,
          mintRecipient: mintRecipientBytes32,
          burnToken: fromChain.evm!.usdc,
          destinationCaller: `0x${"00".repeat(32)}` as `0x${string}`,
          maxFee,
          minFinalityThreshold: activeFee.finalityThreshold,
        });
        setProgress((p) => ({ ...p, burnTx: burnHash }));
        const bs = await waitForReceipt(fromChain, burnHash);
        if (bs !== "success") throw new Error("Burn reverted");
        setProgress((p) => ({
          ...p,
          burnTx: burnHash,
          phase: "attesting",
          attestStartedAt: Date.now(),
          etaSeconds: cctpEtaSeconds(fromChain.domainId, activeFee.finalityThreshold),
        }));

        // Attest
        const controller = new AbortController();
        pollAbort.current = controller;
        const attestation = await pollAttestation(
          config.irisApiUrl,
          fromChain.domainId,
          burnHash,
          {
            signal: controller.signal,
            onPoll: (u) =>
              setProgress((p) => ({
                ...p,
                pollAttempts: u.attempt,
                irisStatus: u.status,
                finalityThresholdExecuted: u.finalityThresholdExecuted,
                feeExecutedSubunits: u.feeExecuted,
              })),
          },
        );
        setProgress((p) => ({ ...p, attestation, phase: "minting" }));

        // Connect Solana wallet + call receive_message
        await ensureSolanaConnected();

        const { signature } = await solanaReceiveMessage({
          destChain: toChain,
          sourceChain: fromChain,
          recipientPubkey: recipient,
          messageHex: attestation.message,
          attestationHex: attestation.attestation,
        });
        setProgress((p) => ({ ...p, mintTx: signature, phase: "done" }));
        return;
      }

      if (direction === "evm->stellar") {
        const sender = await ensureEvmConnected();
        await ensureEvmOnChain(fromChain);

        // ===== Fund-safety preflight =====
        const kind = stellarRecipientKind(recipient);
        if (kind === "invalid")
          throw new Error(`[safety] Stellar recipient ${recipient} is not a valid G/C/M strkey`);
        // G/M recipients need an established USDC trustline or mint_and_forward reverts.
        if (kind === "G" || kind === "M") {
          try {
            const dest = await fetchStellarBalances(
              config.horizonUrl,
              recipient,
              config.usdcIssuer,
            );
            if (!dest.usdcTrustline) {
              throw new Error(
                `[safety] Stellar recipient ${recipient} has no USDC trustline — burn would succeed but mint_and_forward would revert. Add USDC trustline first, then retry.`,
              );
            }
          } catch (e) {
            if (e instanceof Error && e.message.startsWith("[safety]")) throw e;
            // Account may not exist (404). Treat as missing trustline.
            throw new Error(
              `[safety] Could not verify USDC trustline for ${recipient}. Fund the account + add trustline before bridging.`,
            );
          }
        }

        // Build forwarder args
        const forwarderBytes32 = contractStrkeyToBytes32(config.cctpForwarder);
        const hookData = buildCctpForwarderHookData(recipient);

        // Roundtrip-verify hookData (assert magic, version, length, strkey).
        assertHookDataRoundtrip(hookData, recipient);
        // Forwarder bytes32 must equal both mintRecipient AND destinationCaller, per Circle docs.
        // If we ever pass anything else here, funds become permanently stuck.
        if (forwarderBytes32 !== contractStrkeyToBytes32(config.cctpForwarder))
          throw new Error(`[safety] forwarder bytes32 mismatch`);

        // Approve if needed
        setProgress((p) => ({ ...p, phase: "approving" }));
        const allowance = await fetchEvmUsdcAllowance(fromChain, sender as `0x${string}`);
        if (allowance < parsedAmount) {
          const approveTx = await evmApproveUsdc(
            fromChain,
            sender as `0x${string}`,
            parsedAmount,
          );
          setProgress((p) => ({ ...p, approveTx }));
          const s = await waitForReceipt(fromChain, approveTx);
          if (s !== "success") throw new Error("Approve reverted");
        }

        // Burn with hook
        setProgress((p) => ({ ...p, phase: "burning" }));
        if (toChain.domainId !== STELLAR_DOMAIN_ID)
          throw new Error(
            `[safety] toChain domain ${toChain.domainId} != Stellar domain ${STELLAR_DOMAIN_ID}`,
          );
        const burnHash = await evmDepositForBurn(fromChain, sender as `0x${string}`, {
          amount: parsedAmount,
          destinationDomain: STELLAR_DOMAIN_ID,
          mintRecipient: forwarderBytes32,
          burnToken: fromChain.evm!.usdc,
          destinationCaller: forwarderBytes32,
          maxFee,
          minFinalityThreshold: activeFee.finalityThreshold,
          hookData,
        });
        setProgress((p) => ({ ...p, burnTx: burnHash }));
        const bs = await waitForReceipt(fromChain, burnHash);
        if (bs !== "success") throw new Error("Burn reverted");
        setProgress((p) => ({
          ...p,
          burnTx: burnHash,
          phase: "attesting",
          attestStartedAt: Date.now(),
          etaSeconds: cctpEtaSeconds(fromChain.domainId, activeFee.finalityThreshold),
        }));

        const controller = new AbortController();
        pollAbort.current = controller;
        const attestation = await pollAttestation(
          config.irisApiUrl,
          fromChain.domainId,
          burnHash,
          {
            signal: controller.signal,
            onPoll: (u) =>
              setProgress((p) => ({
                ...p,
                pollAttempts: u.attempt,
                irisStatus: u.status,
                finalityThresholdExecuted: u.finalityThresholdExecuted,
                feeExecutedSubunits: u.feeExecuted,
              })),
          },
        );
        setProgress((p) => ({ ...p, attestation, phase: "minting" }));

        // Stellar mint_and_forward
        const stellarAddr = await ensureStellarConnected();
        const mintTx = await mintAndForwardOnStellar(
          network,
          stellarAddr,
          attestation.message,
          attestation.attestation,
        );
        setProgress((p) => ({ ...p, mintTx, phase: "done" }));
      }

      // Refresh balances
      if (fromChain.kind === "stellar") loadStellarBalance();
      if (fromChain.kind === "evm") loadEvmBalance();
    } catch (e) {
      const msg = formatError(e, "Transfer failed");
      setProgress((p) => ({ ...p, phase: "error", error: msg }));
    } finally {
      setBridging(false);
    }
  };

  // --- Status timeline ---
  const steps: TimelineStep[] = useMemo(() => {
    const list: TimelineStep[] = [];
    list.push({
      key: "approve",
      label: "Approve USDC",
      state:
        progress.phase === "approving"
          ? "active"
          : progress.approveTx ||
              ["burning", "attesting", "minting", "done"].includes(progress.phase)
            ? "done"
            : progress.phase === "error" && !progress.approveTx
              ? "error"
              : "pending",
      hint: progress.approveTx ? shortAddr(progress.approveTx, 10, 8) : undefined,
    });
    list.push({
      key: "burn",
      label: `Burn on ${fromChain.name}`,
      state:
        progress.phase === "burning"
          ? "active"
          : progress.burnTx ||
              ["attesting", "minting", "done"].includes(progress.phase)
            ? "done"
            : progress.phase === "error" && progress.approveTx && !progress.burnTx
              ? "error"
              : "pending",
      hint: progress.burnTx ? shortAddr(progress.burnTx, 10, 8) : undefined,
    });
    list.push({
      key: "attest",
      label: "Circle attestation",
      state:
        progress.phase === "attesting"
          ? "active"
          : progress.attestation
            ? "done"
            : "pending",
      hint:
        progress.phase === "attesting" && progress.pollAttempts
          ? `Polling… attempt ${progress.pollAttempts}`
          : undefined,
    });
    list.push({
      key: "mint",
      label: `Mint on ${toChain.name}`,
      state:
        progress.phase === "minting"
          ? "active"
          : progress.phase === "done"
            ? "done"
            : progress.phase === "error" && progress.attestation && !progress.mintTx
              ? "error"
              : "pending",
      hint: progress.mintTx ? shortAddr(progress.mintTx, 10, 8) : undefined,
    });
    return list;
  }, [progress, fromChain.name, toChain.name]);

  const showProgress =
    bridging ||
    progress.phase === "done" ||
    progress.phase === "error" ||
    !!progress.approveTx ||
    !!progress.burnTx;

  return (
    <div className="min-h-screen">
      <Header
        network={network}
        onNetworkChange={setNetwork}
        stellar={stellarWallet}
        evm={evmWallet}
        solana={solanaWallet}
        onContracts={() => setContractsOpen(true)}
        theme={themeCtl}
      />

      <main className="mx-auto max-w-6xl px-5 pb-10 pt-4">
        <AnimatePresence>
          {stellarWallet.error ? (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <Alert variant="destructive" className="mb-3">
                <AlertTitle>Stellar wallet error</AlertTitle>
                <AlertDescription>{stellarWallet.error}</AlertDescription>
              </Alert>
            </motion.div>
          ) : null}
          {evmWallet.error ? (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <Alert variant="destructive" className="mb-3">
                <AlertTitle>EVM wallet error</AlertTitle>
                <AlertDescription>{evmWallet.error}</AlertDescription>
              </Alert>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* Compact masthead — one liner */}
        <div className="mb-4 flex items-baseline justify-between border-b border-border-strong pb-3">
          <h1 className="font-display text-3xl leading-none">
            Cross-chain <span className="italic text-muted-foreground">issuance.</span>
          </h1>
          <p className="hidden text-xs text-muted-foreground sm:block">
            USDC burn-and-mint · Circle CCTP V2
          </p>
        </div>

        {/* 2-column layout: left form, right rail */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_22rem]">
          <div className="min-w-0">

        {/* 01 / FROM */}
        <Section number="01" title="From">
          <ChainSection
            label="From"
            chain={fromChain}
            chains={allChains}
            onChainChange={setFromChain}
            filterUnsupported={(c) => c.supportedSource}
            tokenSymbol={fromToken.symbol}
            amount={amount}
            onAmountChange={(v) => setAmount(v.replace(/[^0-9.]/g, ""))}
            balanceDisplay={sourceBalDisplay}
            balanceLoading={sourceBalLoading}
            onMax={sourceBalanceRaw > 0n ? handleMax : undefined}
            onRefreshBalance={
              fromChain.kind === "stellar" ? loadStellarBalance : loadEvmBalance
            }
            invalid={amountInvalid || insufficient}
            sourceAddress={sourceWalletAddress}
            walletConnected={!!sourceWalletAddress}
            onConnectWallet={() => connectWalletFor(fromChain.kind)}
            walletConnecting={connectingWalletFor(fromChain.kind)}
            kind="from"
          />
        </Section>

        <div className="my-3 flex items-center gap-3">
          <div className="h-px flex-1 bg-border-strong" />
          <motion.button
            key={`swap-${swapKick}`}
            type="button"
            onClick={handleSwap}
            disabled={!toChain.supportedSource}
            className="grid size-9 place-items-center border-2 border-foreground bg-background text-foreground transition-colors hover:bg-foreground hover:text-background disabled:cursor-not-allowed disabled:border-border disabled:text-muted-foreground"
            title={toChain.supportedSource ? "Swap direction" : "Reverse not supported"}
            whileTap={{ scale: 0.9 }}
            initial={{ rotate: 0 }}
            animate={{ rotate: swapKick * 180 }}
            transition={{ type: "spring", stiffness: 360, damping: 22 }}
          >
            <ArrowDown className="size-4" />
          </motion.button>
          <div className="h-px flex-1 bg-border-strong" />
        </div>

        {/* 02 / TO */}
        <Section number="02" title="To">
          <ChainSection
            label="To"
            chain={toChain}
            chains={allChains.filter((c) => c.id !== fromChain.id)}
            onChainChange={setToChain}
            tokenSymbol={toToken.symbol}
            amount={
              receiveAmount > 0n ? formatUsdc(receiveAmount, USDC_DECIMALS_CCTP) : ""
            }
            readOnly
            sourceAddress={destWalletAddress}
            kind="to"
          />
        </Section>

        {/* 03 / RECIPIENT */}
        <Section number="03" title="Recipient">
          <RecipientSection
            chain={toChain}
            value={recipient}
            onConnect={() => connectWalletFor(toChain.kind)}
            connecting={connectingWalletFor(toChain.kind)}
            walletAddress={walletAddressFor(toChain.kind)}
            isCustom={useCustomRecipient}
            onToggleCustom={(v) => {
              setUseCustomRecipient(v);
              if (!v) setRecipient(walletAddressFor(toChain.kind) ?? "");
              else setRecipient("");
            }}
            onChange={setRecipient}
            invalid={recipientInvalid}
          />
        </Section>

        {/* 04 / SPEED */}
        <Section number="04" title="Transfer mode">
          <SpeedSection
            speed={speed}
            onChange={setSpeed}
            fees={fees}
            loading={feesLoading}
            onRefresh={refreshFees}
          />
        </Section>

        <AnimatePresence>
          {stellarBalances && !stellarBalances.usdcTrustline && fromChain.kind === "stellar" && stellarWallet.address ? (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <Alert variant="destructive" className="mt-3">
                <AlertTitle>No USDC trustline</AlertTitle>
                <AlertDescription>
                  Stellar account needs USDC trustline (issuer{" "}
                  <code className="font-mono">{shortAddr(config.usdcIssuer, 4, 4)}</code>) before bridging from Stellar.
                </AlertDescription>
              </Alert>
            </motion.div>
          ) : null}

          {!supported ? (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <Alert className="mt-3">
                <Info className="size-4" />
                <AlertTitle>Route not supported</AlertTitle>
                <AlertDescription>
                  {fromChain.name} → {toChain.name} can't run via this UI yet.
                </AlertDescription>
              </Alert>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <PrimaryButton
          bridging={bridging}
          canBridge={canBridge}
          onBridge={handleBridge}
          insufficient={insufficient}
          toChainName={toChain.name}
          recipientMissing={!recipient || recipientInvalid}
          amountMissing={!parsedAmount || parsedAmount === 0n}
          sourceConnected={!!sourceWalletAddress}
          sourceKind={fromChain.kind}
          phase={progress.phase}
        />
          </div>

          {/* Right rail */}
          <aside className="lg:sticky lg:top-20 lg:self-start">
            <div className="space-y-4">
              <div>
                <div className="mb-2 flex items-baseline justify-between border-b border-border-strong pb-1">
                  <span className="eyebrow">Quote</span>
                  {activeFee ? (
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {activeFee.minimumFee} bps · {speed}
                    </span>
                  ) : null}
                </div>
                {parsedAmount && parsedAmount > 0n ? (
                  <SummarySection
                    parsedAmount={parsedAmount}
                    fromDecimals={fromDecimals}
                    cctpAmount={cctpAmount}
                    receiveAmount={receiveAmount}
                    maxFee={maxFee}
                    activeFee={activeFee}
                    toChain={toChain}
                    fromChain={fromChain}
                    direction={direction}
                    etaSeconds={
                      activeFee ? cctpEtaSeconds(fromChain.domainId, activeFee.finalityThreshold) : null
                    }
                  />
                ) : (
                  <div className="border border-dashed border-border-strong bg-card p-5 text-center">
                    <p className="font-mono text-[11px] text-muted-foreground">
                      Enter amount to see quote
                    </p>
                  </div>
                )}
              </div>

              {showProgress ? (
                <div>
                  <div className="mb-2 flex items-baseline justify-between border-b border-border-strong pb-1">
                    <span className="eyebrow">Status</span>
                    {progress.phase === "done" ? <Badge variant="success">Done</Badge> : null}
                    {progress.phase === "error" ? <Badge variant="destructive">Failed</Badge> : null}
                  </div>
                  <ProgressCard
                    steps={steps}
                    approveTx={progress.approveTx}
                    burnTx={progress.burnTx}
                    mintTx={progress.mintTx}
                    error={progress.error}
                    phase={progress.phase}
                    fromChain={fromChain}
                    toChain={toChain}
                    onReset={resetProgress}
                    attestation={progress.attestation}
                    irisStatus={progress.irisStatus}
                    attestStartedAt={progress.attestStartedAt}
                    etaSeconds={progress.etaSeconds}
                    finalityThresholdExecuted={progress.finalityThresholdExecuted}
                    feeExecutedSubunits={progress.feeExecutedSubunits}
                    onAddTrustline={canFixTrustline ? handleAddTrustline : undefined}
                    addingTrustline={addingTrustline}
                    sendAmount={progress.sendAmount}
                    receiveAmount={progress.receiveAmount}
                    fromShort={progress.fromShort}
                    toShort={progress.toShort}
                    onRetryMint={handleRetryMint}
                    canRetryMint={canRetryMint}
                  />
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      </main>

      <Modal
        open={progressOpen && showProgress}
        onClose={() => setProgressOpen(false)}
        title="Transfer status"
        subtitle={`${fromChain.name} → ${toChain.name}`}
        size="md"
      >
        <ProgressCard
          steps={steps}
          approveTx={progress.approveTx}
          burnTx={progress.burnTx}
          mintTx={progress.mintTx}
          error={progress.error}
          phase={progress.phase}
          fromChain={fromChain}
          toChain={toChain}
          onReset={() => {
            resetProgress();
            setProgressOpen(false);
          }}
          attestation={progress.attestation}
          irisStatus={progress.irisStatus}
          attestStartedAt={progress.attestStartedAt}
          etaSeconds={progress.etaSeconds}
          finalityThresholdExecuted={progress.finalityThresholdExecuted}
          feeExecutedSubunits={progress.feeExecutedSubunits}
          onAddTrustline={canFixTrustline ? handleAddTrustline : undefined}
          addingTrustline={addingTrustline}
          sendAmount={progress.sendAmount}
          receiveAmount={progress.receiveAmount}
          fromShort={progress.fromShort}
          toShort={progress.toShort}
          onRetryMint={handleRetryMint}
          canRetryMint={canRetryMint}
        />
      </Modal>

      <Modal
        open={contractsOpen}
        onClose={() => setContractsOpen(false)}
        title="CCTP contracts"
        subtitle={`Stellar ${network} · per Circle docs`}
        size="md"
      >
        <ContractList config={config} />
      </Modal>

      <StellarWalletPicker
        open={stellarWallet.pickerOpen}
        network={network}
        onClose={stellarWallet.closePicker}
        onConnected={(addr, walletId) =>
          stellarWallet.handleConnected(addr, walletId)
        }
      />

      <EvmWalletPicker
        open={evmWallet.pickerOpen}
        onClose={evmWallet.closePicker}
        onPickInjected={evmWallet.pickInjected}
        onPickWalletConnect={evmWallet.pickWalletConnect}
        injectedAvailable={evmWallet.injectedAvailable}
        wcAvailable={evmWallet.wcAvailable}
        connecting={evmWallet.connecting}
        error={evmWallet.error}
      />
    </div>
  );
}

// ============== Components ==============

function Section({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-5">
      <div className="mb-2 flex items-baseline justify-between border-b border-border-strong pb-1">
        <div className="flex items-baseline gap-2">
          <span className="eyebrow">{number}</span>
          <span className="text-xs font-medium uppercase tracking-wider text-foreground">
            {title}
          </span>
        </div>
      </div>
      {children}
    </section>
  );
}

function Header({
  network,
  onNetworkChange,
  stellar,
  evm,
  solana,
  onContracts,
  theme,
}: {
  network: StellarNetwork;
  onNetworkChange: (n: StellarNetwork) => void;
  stellar: ReturnType<typeof useWallet>;
  evm: ReturnType<typeof useEvmWallet>;
  solana: ReturnType<typeof useSolanaWallet>;
  onContracts: () => void;
  theme: ReturnType<typeof useTheme>;
}) {
  return (
    <header className="sticky top-0 z-40 border-b-2 border-foreground bg-background">
      <div className="mx-auto flex max-w-6xl items-stretch justify-between gap-0 px-5">
        <div className="flex items-center gap-3 border-r border-border-strong py-3 pr-4">
          <div className="grid size-8 place-items-center bg-primary font-black text-primary-foreground">
            +
          </div>
          <div className="leading-none">
            <div className="font-display text-2xl">CCTP Bridge</div>
            <div className="eyebrow mt-0.5">Circle · V2</div>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-end gap-2 py-3">
          <div className="flex border border-foreground">
            <NetTab active={network === "testnet"} onClick={() => onNetworkChange("testnet")}>
              Test
            </NetTab>
            <NetTab active={network === "mainnet"} onClick={() => onNetworkChange("mainnet")}>
              Main
            </NetTab>
          </div>
          <button
            type="button"
            onClick={onContracts}
            className="hidden border border-border-strong px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground hover:bg-foreground hover:text-background sm:inline-block"
          >
            Refs
          </button>
          <button
            type="button"
            onClick={theme.toggleTheme}
            title={`Theme: ${theme.theme}`}
            className="border border-border-strong p-2 text-muted-foreground hover:bg-foreground hover:text-background"
          >
            {theme.theme === "dark" ? (
              <Sun className="size-3.5" />
            ) : (
              <Moon className="size-3.5" />
            )}
          </button>
          <WalletPill
            connected={!!stellar.address}
            label="Stellar"
            address={stellar.address}
            onConnect={stellar.connect}
            onDisconnect={stellar.disconnect}
            connecting={stellar.connecting}
            color="bg-primary"
          />
          <WalletPill
            connected={!!evm.address}
            label="EVM"
            address={evm.address}
            onConnect={evm.connect}
            onDisconnect={evm.disconnect}
            connecting={evm.connecting}
            color="bg-foreground"
          />
          <WalletPill
            connected={!!solana.address}
            label="Solana"
            address={solana.address}
            onConnect={solana.connect}
            onDisconnect={solana.disconnect}
            connecting={solana.connecting}
            color="bg-[#9945FF]"
          />
        </div>
      </div>
    </header>
  );
}

function NetTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors",
        active
          ? "bg-foreground text-background"
          : "bg-background text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function WalletPill({
  connected,
  label,
  address,
  onConnect,
  onDisconnect,
  connecting,
  color,
}: {
  connected: boolean;
  label: string;
  address: string | null;
  onConnect: () => Promise<void> | void;
  onDisconnect: () => void | Promise<void>;
  connecting: boolean;
  color: string;
}) {
  if (connected && address) {
    return (
      <div className="flex items-center gap-1.5 border border-border-strong px-2.5 py-1.5 text-sm">
        <span className={cn("size-1.5", color)} />
        <span className="hidden text-[10px] font-bold uppercase tracking-wider text-muted-foreground sm:inline">
          {label}
        </span>
        <span className="font-mono text-xs">{shortAddr(address, 4, 4)}</span>
        <button
          onClick={onDisconnect}
          title={`Disconnect ${label}`}
          className="text-muted-foreground hover:text-foreground"
        >
          <LogOut className="size-3" />
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onConnect}
      disabled={connecting}
      className="flex items-center gap-1.5 border border-foreground px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider hover:bg-foreground hover:text-background disabled:opacity-50"
    >
      {connecting ? <Loader2 className="size-3.5 animate-spin" /> : <Wallet className="size-3.5" />}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function ChainSection({
  label,
  chain,
  chains,
  onChainChange,
  filterUnsupported,
  tokenSymbol,
  amount,
  onAmountChange,
  balanceDisplay,
  balanceLoading,
  onMax,
  onRefreshBalance,
  invalid,
  sourceAddress,
  walletConnected,
  onConnectWallet,
  walletConnecting,
  readOnly,
  kind,
}: {
  label: string;
  chain: ChainInfo;
  chains: ChainInfo[];
  onChainChange: (c: ChainInfo) => void;
  filterUnsupported?: (c: ChainInfo) => boolean;
  tokenSymbol: string;
  amount: string;
  onAmountChange?: (v: string) => void;
  balanceDisplay?: string | null;
  balanceLoading?: boolean;
  onMax?: () => void;
  onRefreshBalance?: () => void;
  invalid?: boolean;
  sourceAddress?: string | null;
  walletConnected?: boolean;
  onConnectWallet?: () => void | Promise<void>;
  walletConnecting?: boolean;
  readOnly?: boolean;
  kind: "from" | "to";
}) {
  return (
    <div
      className={cn(
        "border border-border-strong bg-card p-4",
        invalid && "border-destructive",
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <ChainPicker
          chains={chains}
          value={chain}
          onChange={onChainChange}
          filterUnsupported={filterUnsupported}
          label={label}
        />
        {sourceAddress ? (
          <span className="border border-border-strong px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            {shortAddr(sourceAddress, 4, 4)}
          </span>
        ) : null}
      </div>
      <div className="flex items-end justify-between gap-3">
        <input
          inputMode="decimal"
          placeholder="0"
          value={amount}
          readOnly={readOnly}
          onChange={(e) => onAmountChange?.(e.target.value)}
          className={cn(
            "font-display min-w-0 flex-1 bg-transparent text-5xl leading-none tracking-tight outline-none placeholder:text-muted-foreground/30",
            readOnly && "cursor-default",
            invalid && "text-destructive",
          )}
        />
        <TokenChip symbol={tokenSymbol} />
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-border pt-2 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-1.5">
          {kind === "from" ? (
            walletConnected ? (
              <span className="flex items-center gap-1.5">
                <span className="eyebrow">Bal</span>
                {balanceLoading ? (
                  <Skeleton className="h-3.5 w-16" />
                ) : balanceDisplay !== null && balanceDisplay !== undefined ? (
                  <>
                    <span className="font-mono text-foreground">{balanceDisplay}</span>
                    <span className="font-mono">{tokenSymbol}</span>
                  </>
                ) : (
                  <>
                    <span className="font-mono text-foreground">—</span>
                    <span className="font-mono">{tokenSymbol}</span>
                  </>
                )}
                {onRefreshBalance ? (
                  <button
                    onClick={onRefreshBalance}
                    title="Refresh balance"
                    disabled={balanceLoading}
                    className="ml-0.5 p-0.5 hover:text-foreground disabled:opacity-60"
                  >
                    <RefreshCw className={cn("size-3", balanceLoading && "animate-spin")} />
                  </button>
                ) : null}
              </span>
            ) : onConnectWallet ? (
              <button
                type="button"
                onClick={onConnectWallet}
                disabled={!!walletConnecting}
                className="flex items-center gap-1.5 border border-foreground bg-foreground px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-background hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
              >
                {walletConnecting ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Wallet className="size-3" />
                )}
                Connect {chain.name} wallet
              </button>
            ) : (
              <span className="eyebrow normal-case tracking-normal">Connect wallet</span>
            )
          ) : (
            <span className="eyebrow">After fees</span>
          )}
        </div>
        {kind === "from" && onMax ? (
          <button
            type="button"
            onClick={onMax}
            className="border border-foreground bg-primary px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-primary-foreground hover:bg-foreground hover:text-background"
          >
            Max
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RecipientSection({
  chain,
  value,
  onConnect,
  connecting,
  walletAddress,
  isCustom,
  onToggleCustom,
  onChange,
  invalid,
}: {
  chain: ChainInfo;
  value: string;
  onConnect: () => Promise<void>;
  connecting: boolean;
  walletAddress: string | null;
  isCustom: boolean;
  onToggleCustom: (v: boolean) => void;
  onChange: (v: string) => void;
  invalid?: boolean;
}) {
  const walletConnected = !!walletAddress;
  const placeholder =
    chain.kind === "evm" ? "0x…" : chain.kind === "solana" ? "Base58 pubkey" : "G…, C…, or M…";

  return (
    <div
      className={cn(
        "border border-border-strong bg-card p-3",
        invalid && "border-destructive",
      )}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="eyebrow flex items-center gap-1.5">
          <ChainLogo chain={chain} size={12} />
          {chain.kind} address · {chain.name}
        </span>
        <div className="flex items-center gap-2">
          {isCustom ? (
            <span className="font-mono text-[10px] text-warning">
              ⚠ custom address
            </span>
          ) : walletConnected ? (
            <span className="font-mono text-[10px] text-muted-foreground">
              Locked from wallet
            </span>
          ) : null}
          {walletConnected || isCustom ? (
            <button
              type="button"
              onClick={() => onToggleCustom(!isCustom)}
              className="border border-border-strong bg-card-elevated px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider hover:bg-foreground hover:text-background"
            >
              {isCustom ? "Use my wallet" : "Use other address"}
            </button>
          ) : null}
        </div>
      </div>

      {isCustom ? (
        <>
          <input
            spellCheck={false}
            autoFocus
            placeholder={placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value.trim())}
            className={cn(
              "w-full bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground/40",
              invalid && "text-destructive",
            )}
          />
          {invalid ? (
            <p className="mt-1 text-[11px] text-destructive">
              Invalid {chain.kind.toUpperCase()} address.
            </p>
          ) : null}
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            Funds will mint to this address on {chain.name}. Double-check —
            CCTP burns are irreversible. We still verify ATA / trustline
            before burn, but you own this risk.
          </p>
        </>
      ) : walletConnected ? (
        <div className="break-all font-mono text-sm" title={value}>
          {value}
        </div>
      ) : (
        <button
          type="button"
          onClick={onConnect}
          disabled={connecting}
          className="flex w-full items-center justify-center gap-2 border-2 border-foreground bg-foreground py-2 text-[11px] font-bold uppercase tracking-wider text-background hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
        >
          {connecting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Wallet className="size-3.5" />
          )}
          Connect {chain.name} wallet to receive
        </button>
      )}

      {!isCustom && !walletConnected ? (
        <button
          type="button"
          onClick={() => onToggleCustom(true)}
          className="mt-2 w-full text-center text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          or enter address manually →
        </button>
      ) : null}
    </div>
  );
}

function SpeedSection({
  speed,
  onChange,
  fees,
  loading,
  onRefresh,
}: {
  speed: Speed;
  onChange: (s: Speed) => void;
  fees: { fast: BurnFee; slow: BurnFee } | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="mt-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <SpeedTile
          active={speed === "fast"}
          onClick={() => onChange("fast")}
          title="Fast"
          subtitle="≈ seconds"
          fee={fees?.fast}
          loading={loading}
          icon={<Zap className="size-3.5" />}
        />
        <SpeedTile
          active={speed === "standard"}
          onClick={() => onChange("standard")}
          title="Standard"
          subtitle="≈ 13–19 min"
          fee={fees?.slow}
          loading={loading}
        />
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          title="Refetch Iris fees"
          className="flex items-center gap-1 border border-border-strong bg-card-elevated px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-foreground hover:text-background disabled:opacity-60"
        >
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          Refresh fees
        </button>
      </div>
    </div>
  );
}

function SpeedTile({
  active,
  onClick,
  title,
  subtitle,
  fee,
  loading,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  fee: BurnFee | undefined;
  loading: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileTap={{ scale: 0.98 }}
      className={cn(
        "flex flex-col gap-0.5 border p-3 text-left transition-colors",
        active
          ? "border-foreground bg-primary text-primary-foreground"
          : "border-border-strong bg-card hover:bg-accent",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wide">
          {icon}
          {title}
        </span>
        <span className="flex items-center gap-1">
          {loading ? (
            <Skeleton className="h-3 w-8" />
          ) : fee ? (
            <span className={cn("font-mono text-[10px]", active ? "text-primary-foreground/80" : "text-muted-foreground")}>
              {fee.minimumFee} bps
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground">—</span>
          )}
        </span>
      </div>
      <div className={cn("text-[11px]", active ? "text-primary-foreground/80" : "text-muted-foreground")}>{subtitle}</div>
    </motion.button>
  );
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `≈ ${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `≈ ${m} min`;
  return `≈ ${Math.round(m / 60)}h`;
}

function formatHms(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

function SummarySection({
  parsedAmount,
  fromDecimals,
  cctpAmount,
  receiveAmount,
  maxFee,
  activeFee,
  toChain,
  fromChain,
  direction,
  etaSeconds,
}: {
  parsedAmount: bigint | null;
  fromDecimals: number;
  cctpAmount: bigint;
  receiveAmount: bigint;
  maxFee: bigint;
  activeFee?: BurnFee;
  toChain: ChainInfo;
  fromChain: ChainInfo;
  direction: Direction | null;
  etaSeconds: number | null;
}) {
  if (!parsedAmount || parsedAmount === 0n) return null;
  const destDecimals =
    toChain.kind === "stellar" ? USDC_DECIMALS_STELLAR : USDC_DECIMALS_CCTP;
  const destReceive =
    toChain.kind === "stellar"
      ? receiveAmount * 10n ** BigInt(USDC_DECIMALS_STELLAR - USDC_DECIMALS_CCTP)
      : receiveAmount;
  const burnHuman = formatUsdcFixed(parsedAmount, fromDecimals, 7);
  const receiveHuman = formatUsdcFixed(destReceive, destDecimals, 7);
  const feeHuman = formatUsdcFixed(maxFee, USDC_DECIMALS_CCTP, 7);
  const feeIsZero = maxFee === 0n;
  return (
    <div className="mt-4 border border-border-strong">
      <div className="grid grid-cols-2 divide-x divide-border-strong">
        <div className="p-4">
          <div className="eyebrow">Send</div>
          <div className="mt-1 font-mono text-lg font-bold tracking-tight">
            {burnHuman}
          </div>
        </div>
        <div className="bg-primary p-4 text-primary-foreground">
          <div className="eyebrow !text-primary-foreground/70">Receive ≥</div>
          <div className="mt-1 font-mono text-lg font-bold tracking-tight">
            {receiveHuman}
          </div>
        </div>
      </div>
      <div className="border-t border-border-strong">
        <Row
          label={activeFee ? `Fee · ${activeFee.minimumFee} bps max` : "Fee"}
          value={feeIsZero ? "0.0000000 (0 bps)" : feeHuman}
        />
        <Row
          label="Est. time"
          value={etaSeconds !== null ? formatEta(etaSeconds) : "—"}
        />
        <Row
          label="Route"
          value={`${fromChain.shortName}/${fromChain.domainId} → ${toChain.shortName}/${toChain.domainId}`}
        />
        <Row
          label="Path"
          value={
            direction === "evm->stellar"
              ? "via CctpForwarder"
              : direction === "stellar->evm"
                ? "direct deposit_for_burn"
                : "depositForBurn"
          }
          muted
        />
        <Row
          label="CCTP canonical"
          value={`${formatUsdcFixed(cctpAmount, USDC_DECIMALS_CCTP, 7)} USDC`}
          muted
        />
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  emphasize,
  muted,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2 text-sm last:border-b-0">
      <span className="eyebrow">{label}</span>
      <span
        className={cn(
          "font-mono text-foreground",
          emphasize && "text-base font-semibold",
          muted && "text-xs text-muted-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function PrimaryButton({
  bridging,
  canBridge,
  onBridge,
  insufficient,
  toChainName,
  recipientMissing,
  amountMissing,
  sourceConnected,
  sourceKind,
  phase,
}: {
  bridging: boolean;
  canBridge: boolean;
  onBridge: () => Promise<void>;
  insufficient: boolean;
  toChainName: string;
  recipientMissing: boolean;
  amountMissing: boolean;
  sourceConnected: boolean;
  sourceKind: string;
  phase: Phase;
}) {
  let label: React.ReactNode;
  if (bridging) {
    const phaseLabel: Record<Phase, string> = {
      idle: "Bridging…",
      approving: "Approving…",
      burning: `Burning on source…`,
      attesting: "Waiting attestation…",
      minting: `Minting on ${toChainName}…`,
      done: "Done",
      error: "Error",
    };
    label = (
      <>
        <Loader2 className="size-4 animate-spin" /> {phaseLabel[phase]}
      </>
    );
  } else if (!sourceConnected) {
    label = (
      <>
        <Wallet className="size-4" /> Connect {sourceKind === "stellar" ? "Stellar" : "EVM"} wallet
      </>
    );
  } else if (amountMissing) {
    label = "Enter amount";
  } else if (insufficient) {
    label = "Insufficient balance";
  } else if (recipientMissing) {
    label = "Enter recipient";
  } else {
    label = (
      <>
        Bridge to {toChainName} <ArrowUpRight className="size-4" />
      </>
    );
  }
  return (
    <button
      type="button"
      disabled={!canBridge && sourceConnected}
      onClick={onBridge}
      className={cn(
        "mt-5 flex h-14 w-full items-center justify-center gap-2 border-2 border-foreground text-base font-black uppercase tracking-wider transition-colors",
        canBridge || !sourceConnected
          ? "bg-primary text-primary-foreground hover:bg-foreground hover:text-background"
          : "cursor-not-allowed bg-muted text-muted-foreground opacity-60",
      )}
    >
      {label}
    </button>
  );
}

function useTicker(enabled: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return tick;
}

function ProgressCard({
  steps,
  approveTx,
  burnTx,
  mintTx,
  error,
  phase,
  fromChain,
  toChain,
  onReset,
  attestation,
  irisStatus,
  attestStartedAt,
  etaSeconds,
  finalityThresholdExecuted,
  feeExecutedSubunits,
  onAddTrustline,
  addingTrustline,
  sendAmount,
  receiveAmount,
  fromShort,
  toShort,
  onRetryMint,
  canRetryMint,
}: {
  steps: TimelineStep[];
  approveTx?: string;
  burnTx?: string;
  mintTx?: string;
  error?: string;
  phase: Phase;
  fromChain: ChainInfo;
  toChain: ChainInfo;
  onReset: () => void;
  attestation?: CctpAttestation;
  irisStatus?: string;
  attestStartedAt?: number;
  etaSeconds?: number;
  finalityThresholdExecuted?: number;
  feeExecutedSubunits?: string;
  onAddTrustline?: () => void | Promise<void>;
  addingTrustline?: boolean;
  sendAmount?: string;
  receiveAmount?: string;
  fromShort?: string;
  toShort?: string;
  onRetryMint?: () => void | Promise<void>;
  canRetryMint?: boolean;
}) {
  useTicker(phase === "attesting" && !!attestStartedAt);
  const elapsed =
    attestStartedAt ? Math.floor((Date.now() - attestStartedAt) / 1000) : 0;
  const remaining =
    etaSeconds !== undefined && etaSeconds > elapsed ? etaSeconds - elapsed : 0;
  return (
    <div className="bg-card p-5">
      {sendAmount && receiveAmount && fromShort && toShort ? (
        <div className="mb-4 grid grid-cols-[1fr_auto_1fr] items-center gap-3 border border-border-strong bg-card-elevated p-3">
          <div className="min-w-0">
            <div className="eyebrow">Send · {fromShort}</div>
            <div className="truncate font-mono text-base font-bold">
              {sendAmount} <span className="text-muted-foreground">USDC</span>
            </div>
          </div>
          <div className="text-muted-foreground">→</div>
          <div className="min-w-0 text-right">
            <div className="eyebrow">Receive · {toShort}</div>
            <div className="truncate font-mono text-base font-bold">
              {receiveAmount} <span className="text-muted-foreground">USDC</span>
            </div>
          </div>
        </div>
      ) : null}

      <div className="mb-3 flex items-center justify-between border-b border-border-strong pb-2">
        <span className="eyebrow">Status</span>
        {phase === "done" ? <Badge variant="success">Completed</Badge> : null}
        {phase === "error" ? <Badge variant="destructive">Failed</Badge> : null}
        {phase === "attesting" ? (
          <span className="border border-border-strong px-2 py-0.5 font-mono text-[10px] uppercase">
            {irisStatus ?? "polling"}
          </span>
        ) : null}
      </div>

      {phase === "attesting" && etaSeconds !== undefined ? (
        <div className="mb-4 border border-border-strong p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="eyebrow">Attestation</span>
            <span className="font-mono text-foreground">
              {remaining > 0 ? `~${formatHms(remaining)} left` : "any moment…"}
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden bg-muted">
            <div
              className="h-full bg-primary transition-all duration-1000"
              style={{
                width: `${etaSeconds > 0 ? Math.min(100, (elapsed / etaSeconds) * 100) : 0}%`,
              }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>elapsed {formatHms(elapsed)}</span>
            {finalityThresholdExecuted !== undefined ? (
              <span>
                finality {finalityThresholdExecuted}
              </span>
            ) : null}
            {feeExecutedSubunits !== undefined ? (
              <span>
                fee {formatUsdcFixed(BigInt(feeExecutedSubunits), USDC_DECIMALS_CCTP, 7)}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <StatusTimeline steps={steps} />
      <div className="mt-4 space-y-2">
        {approveTx ? (
          <TxLink label={`Approve on ${fromChain.name}`} hash={approveTx} url={fromChain.explorerTxUrl(approveTx)} />
        ) : null}
        {burnTx ? (
          <TxLink label={`Burn on ${fromChain.name}`} hash={burnTx} url={fromChain.explorerTxUrl(burnTx)} />
        ) : null}
        {mintTx ? (
          <TxLink label={`Mint on ${toChain.name}`} hash={mintTx} url={toChain.explorerTxUrl(mintTx)} />
        ) : null}
      </div>

      {error ? (
        <Alert variant="destructive" className="mt-3">
          <AlertTitle>Transfer failed</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
          {onAddTrustline ? (
            <button
              type="button"
              onClick={onAddTrustline}
              disabled={addingTrustline}
              className="mt-3 flex w-full items-center justify-center gap-2 border-2 border-background bg-background py-2 text-[11px] font-bold uppercase tracking-wider text-foreground hover:bg-foreground hover:text-background disabled:opacity-60"
            >
              {addingTrustline ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              {addingTrustline ? "Adding trustline…" : "Add USDC trustline + retry"}
            </button>
          ) : null}
        </Alert>
      ) : null}

      {canRetryMint && onRetryMint ? (
        <div className="mt-3 border border-border-strong bg-card-elevated p-3">
          <div className="eyebrow mb-1">Burn confirmed · mint pending</div>
          <p className="mb-2 text-[11px] text-muted-foreground">
            Your USDC is already burned on {fromChain.name} and attested by
            Circle. Click below to (re)submit the mint on {toChain.name}.
            Safe to retry — CCTP rejects already-used nonces.
          </p>
          <button
            type="button"
            onClick={onRetryMint}
            className="flex w-full items-center justify-center gap-2 border-2 border-foreground bg-primary py-2 text-[11px] font-bold uppercase tracking-wider text-primary-foreground hover:bg-foreground hover:text-background"
          >
            <ArrowUpRight className="size-3.5" />
            Retry mint on {toChain.name}
          </button>
        </div>
      ) : null}

      {attestation && phase !== "done" ? <AttestationPanel attestation={attestation} /> : null}

      {phase === "done" || phase === "error" ? (
        <Button variant="outline" onClick={onReset} className="mt-4 w-full">
          Start a new transfer
        </Button>
      ) : null}
    </div>
  );
}

function TxLink({ label, hash, url }: { label: string; hash: string; url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center justify-between border border-border-strong bg-card-elevated px-3 py-2 text-sm transition-colors hover:bg-accent"
    >
      <div>
        <div className="eyebrow">{label}</div>
        <div className="font-mono text-xs">{shortAddr(hash, 10, 8)}</div>
      </div>
      <ExternalLink className="size-3.5 text-muted-foreground" />
    </a>
  );
}

function AttestationPanel({ attestation }: { attestation: CctpAttestation }) {
  return (
    <div className="mt-4 space-y-3 border-2 border-primary bg-primary/10 p-4">
      <div className="flex items-center gap-2">
        <Check className="size-4 text-primary" />
        <span className="text-sm font-bold uppercase tracking-wide">
          Attestation ready · auto-claiming
        </span>
      </div>
      <HexField label="message" value={attestation.message} />
      <HexField label="attestation" value={attestation.attestation} />
    </div>
  );
}

function HexField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="eyebrow">{label}</span>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1 border border-border-strong bg-background px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider hover:bg-foreground hover:text-background"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="max-h-24 overflow-auto break-all border border-border-strong bg-background p-2 font-mono text-[11px] leading-snug">
        {value}
      </div>
    </div>
  );
}

function ContractList({
  config,
}: {
  config: {
    tokenMessengerMinter: string;
    messageTransmitter: string;
    cctpForwarder: string;
    usdcContract: string;
  };
}) {
  const rows = [
    { label: "TokenMessengerMinter", addr: config.tokenMessengerMinter },
    { label: "MessageTransmitter", addr: config.messageTransmitter },
    { label: "CctpForwarder", addr: config.cctpForwarder },
    { label: "USDC SAC", addr: config.usdcContract },
  ];
  return (
    <div className="space-y-2 p-4">
      {rows.map((r) => (
        <CopyableRow key={r.label} label={r.label} value={r.addr} />
      ))}
      <p className="pt-2 text-[11px] text-muted-foreground">
        EVM V2 contracts shared across all chains: TokenMessenger{" "}
        <code className="font-mono">0x28b5…cf5d</code>, MessageTransmitter{" "}
        <code className="font-mono">0x81D4…4B64</code>.
      </p>
    </div>
  );
}

function CopyableRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="flex w-full items-center justify-between gap-3 border border-border-strong bg-card-elevated px-3 py-2 text-left text-sm hover:bg-accent"
    >
      <div>
        <div className="eyebrow">{label}</div>
        <div className="font-mono text-xs">{shortAddr(value, 8, 8)}</div>
      </div>
      <span className="border border-border-strong bg-background px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
        {copied ? "Copied" : "Copy"}
      </span>
    </button>
  );
}

export default App;

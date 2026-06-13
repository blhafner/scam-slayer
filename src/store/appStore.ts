/**
 * appStore.ts — zustand store for Scam Slayer.
 *
 * All reactive state + the actions that drive it, translated 1:1 from the
 * pre-refactor App.tsx callbacks:
 * - MetaMask wallet connection + smart account creation
 * - ERC-7710 delegation from operator → agent (+ A2A redelegation)
 * - Venice AI phishing analysis (vision + text, API key or x402)
 * - Approval scanning + heuristic risk scoring
 * - Autonomous revocation via delegation redemption
 *
 * Non-reactive SDK handles (account instances, signed delegations) live in
 * ./runtime — see that file for why.
 */

import { create } from "zustand";
import type { Address, Hex } from "viem";
import type {
  AppConfig,
  BudgetState,
  TokenApproval,
  Kill,
  LogEntry,
  PhishingAnalysis,
} from "../lib/types";
import {
  getWalletClient,
  createOperatorAccount,
  createAgentAccount,
  createSubAgentAccount,
  createAgentDelegation,
  createRedelegation,
  createBudgetDelegation,
  createAgent7702Account,
  getDelegationUsesLeft,
  getChainId,
  executeRevocation,
  readAllowance,
  revokeApprovalDirect,
  createSmartAccountApproval,
  ensureSmartAccountDeployed,
  deployMaliciousSpender,
  createEoaMaxApproval,
  shortenAddress,
  USDC_DECIMALS,
} from "../lib/wallet";
import {
  analyzeScreenshotDetailed,
  analyzeUrlDetailed,
  VISION_MODEL,
  TEXT_MODEL,
} from "../lib/venice";
import {
  analyzeViaX402,
  getX402Balance,
  getX402WalletAddress,
} from "../lib/x402";
import { revokeViaRelayer } from "../lib/oneshot";
import { fetchApprovals, getMockApprovals } from "../lib/scanner";
import {
  CHAINS,
  DEFAULT_CHAIN_ID,
  setActiveChain,
  getActiveChainConfig,
} from "../lib/chains";
import { runtime, resetAccountRuntime } from "./runtime";
import { DEMO_ADDRS, createDemoAnalysis, createUnavailableAnalysis } from "../demo";

export const DEFAULT_SCOPE_TARGETS: Address[] = [
  "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // USDC (Sepolia)
  "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9", // WETH (Sepolia)
  "0x779877A7B0D9E8603169DdbD7836e478b4624789", // LINK (Sepolia)
  "0x68194a729C2450ad26072b3D33ADaCbcef39D574", // DAI (Sepolia)
];

// Token used by the "Create Test Approval (Smart Account)" demo helper (Sepolia).
const TEST_USDC_SEPOLIA: Address = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

// ---- Toasts ----
export interface Toast {
  id: string;
  msg: string;
  type: "info" | "success" | "warn" | "danger";
}

// ---- Persistence helpers ----
export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
export function saveLocal(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

function initConfig(): AppConfig {
  const env = {
    veniceApiKey: import.meta.env.VITE_VENICE_API_KEY || "",
    alchemyApiKey: import.meta.env.VITE_ALCHEMY_API_KEY || "",
    pimlicoApiKey: import.meta.env.VITE_PIMLICO_API_KEY || "",
    etherscanApiKey: import.meta.env.VITE_ETHERSCAN_API_KEY || "",
    x402Enabled: import.meta.env.VITE_X402_ENABLED === "true",
  };
  // Saved config wins per-field, but env fills any blank a saved config left —
  // so newly-added .env keys take effect without clearing localStorage.
  const saved = loadLocal<Partial<AppConfig>>("ss-config", {});
  const envChain = Number(import.meta.env.VITE_CHAIN_ID);
  return {
    chainId:
      (saved.chainId && CHAINS[saved.chainId] ? saved.chainId : undefined) ??
      (CHAINS[envChain] ? envChain : undefined) ??
      DEFAULT_CHAIN_ID,
    veniceApiKey: saved.veniceApiKey || env.veniceApiKey,
    alchemyApiKey: saved.alchemyApiKey || env.alchemyApiKey,
    pimlicoApiKey: saved.pimlicoApiKey || env.pimlicoApiKey,
    etherscanApiKey: saved.etherscanApiKey || env.etherscanApiKey,
    x402Enabled: saved.x402Enabled ?? env.x402Enabled,
    relayerMode:
      saved.relayerMode ??
      ((import.meta.env.VITE_RELAYER_MODE as AppConfig["relayerMode"]) ||
        "pimlico"),
    webhookUrl: saved.webhookUrl || import.meta.env.VITE_RELAYER_WEBHOOK || "",
  };
}

// ---- Store ----

export interface AppState {
  // Config + UI shell
  config: AppConfig;
  showSettings: boolean;
  connectionError: string | null;

  // Wallet
  walletConnected: boolean;
  eoaAddress: Address | null;
  operatorAddress: Address | null;
  agentAddress: Address | null;
  subAgentAddress: Address | null;

  // Delegation
  delegationGranted: boolean;
  delegationUsesLeft: number;
  delegationError: string | null;

  // x402 intelligence budget (operator-signed mandate, client-enforced cap)
  budget: BudgetState;
  x402WalletAddress: string | null;
  x402BalanceUsd: number | null;
  x402CanConsume: boolean | null;
  x402MinimumTopUpUsd: number | null;
  x402StatusError: string | null;

  // Agent
  agentActive: boolean;
  approvals: TokenApproval[];
  kills: Kill[];
  scanProgress: number;

  // Analysis
  selectedThreat: TokenApproval | null;
  veniceResult: PhishingAnalysis | null;
  analysisModelLabel: string | null;
  analyzing: boolean;
  killAnimation: string | null;

  // Log + toasts
  log: LogEntry[];
  toasts: Toast[];

  // Modes
  demoMode: boolean;
  autoMode: boolean;
  autoThreshold: number;
  rescanning: boolean;
  creatingApproval: boolean;
  seeding: boolean;

  // ---- Actions ----
  setShowSettings: (open: boolean) => void;
  setAgentActive: (active: boolean) => void;
  setAutoMode: (on: boolean) => void;
  setAutoThreshold: (n: number) => void;
  clearSelection: () => void;

  addLog: (msg: string, level?: LogEntry["level"]) => void;
  pushToast: (msg: string, type?: Toast["type"]) => void;
  dismissToast: (id: string) => void;

  refreshX402Status: () => Promise<{
    address: string;
    balance: Awaited<ReturnType<typeof getX402Balance>>;
  } | null>;
  applyApprovals: (list: TokenApproval[], opts?: { alert?: boolean }) => void;
  saveConfig: (newConfig: AppConfig) => void;
  enterDemo: () => void;
  rescan: (silent?: boolean) => Promise<void>;
  changeChain: (id: number) => void;
  connect: () => Promise<void>;
  grantDelegation: () => Promise<void>;
  analyze: (opts: { imageBase64?: string; context?: string }) => Promise<void>;
  analyzeThreat: (threat: TokenApproval) => void;
  kill: (approval: TokenApproval) => Promise<void>;
  sweep: (opts?: { manual?: boolean }) => Promise<void>;
  createTestApproval: (spender: string) => Promise<void>;
  seedMaliciousApprovals: () => Promise<void>;
  runScanTick: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  config: initConfig(),
  showSettings: false,
  connectionError: null,

  walletConnected: false,
  eoaAddress: null,
  operatorAddress: null,
  agentAddress: null,
  subAgentAddress: null,

  delegationGranted: false,
  delegationUsesLeft: 10,
  delegationError: null,

  budget: { capUsd: 1, spentUsd: 0, granted: false },
  x402WalletAddress: null,
  x402BalanceUsd: null,
  x402CanConsume: null,
  x402MinimumTopUpUsd: null,
  x402StatusError: null,

  agentActive: true,
  approvals: [],
  kills: loadLocal<Kill[]>("ss-kills", []),
  scanProgress: 0,

  selectedThreat: null,
  veniceResult: null,
  analysisModelLabel: null,
  analyzing: false,
  killAnimation: null,

  log: [],
  toasts: [],

  demoMode: false,
  autoMode: false,
  autoThreshold: 90,
  rescanning: false,
  creatingApproval: false,
  seeding: false,

  // ---- Simple setters ----
  setShowSettings: (open) => set({ showSettings: open }),
  setAgentActive: (active) => set({ agentActive: active }),
  setAutoMode: (on) => set({ autoMode: on }),
  setAutoThreshold: (n) => set({ autoThreshold: n }),
  clearSelection: () => set({ selectedThreat: null, veniceResult: null }),

  // ---- Helpers ----
  addLog: (msg, level = "info") =>
    set((s) => ({
      log: [
        { time: new Date().toLocaleTimeString(), msg, level },
        ...s.log.slice(0, 49),
      ],
    })),

  pushToast: (msg, type = "info") => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, msg, type }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4200);
  },

  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  refreshX402Status: async () => {
    if (!runtime.agentPrivateKey) return null;
    const privateKey = runtime.agentPrivateKey;
    let address: string | null = null;
    try {
      address = await getX402WalletAddress(privateKey);
      set({ x402WalletAddress: address });
    } catch (error: any) {
      set({
        x402StatusError:
          error?.message || "Unable to fetch x402 payer wallet address",
      });
      return null;
    }

    try {
      const balance = await getX402Balance(privateKey);
      set({
        x402BalanceUsd: balance.balanceUsd,
        x402CanConsume: balance.canConsume,
        x402MinimumTopUpUsd: balance.minimumTopUpUsd,
        x402StatusError: null,
      });
      return { address, balance };
    } catch (error: any) {
      set({
        x402BalanceUsd: null,
        x402CanConsume: null,
        x402MinimumTopUpUsd: null,
        x402StatusError: error?.message || "Unable to fetch x402 balance",
      });
      return null;
    }
  },

  // Commit a freshly-scanned approval list. When `alert` is set (background
  // rescans), any high-risk approval not seen on the prior scan is announced via
  // toast + log so new threats are picked up automatically. The initial load
  // seeds the known set silently (alert omitted) so existing approvals don't all
  // fire as "new".
  applyApprovals: (list, opts = {}) => {
    const { addLog, pushToast } = get();
    if (opts.alert) {
      const known = runtime.knownApprovalIds;
      const newThreats = list.filter((a) => a.riskScore > 75 && !known.has(a.id));
      for (const t of newThreats) {
        addLog(
          `🚨 New threat detected: ${t.token} → ${shortenAddress(t.spender)} (risk ${t.riskScore})`,
          "danger"
        );
        pushToast(
          `🚨 New threat: ${t.token} approval to ${shortenAddress(t.spender)}`,
          "danger"
        );
      }
    }
    runtime.knownApprovalIds = new Set(list.map((a) => a.id));
    set({ approvals: list });
  },

  saveConfig: (newConfig) => {
    set({ config: newConfig });
    saveLocal("ss-config", newConfig);
    get().addLog("Configuration saved", "success");
  },

  // Enter the dashboard with mock data and no wallet — lets anyone explore the
  // full UX flow without MetaMask Flask or any API keys.
  enterDemo: () => {
    const { addLog, pushToast } = get();
    set({
      demoMode: true,
      connectionError: null,
      eoaAddress: DEMO_ADDRS.operator,
      operatorAddress: DEMO_ADDRS.operator,
      agentAddress: DEMO_ADDRS.agent,
      subAgentAddress: DEMO_ADDRS.subAgent,
      approvals: getMockApprovals(),
      delegationUsesLeft: 10,
      walletConnected: true,
      delegationGranted: true,
      agentActive: true,
    });
    set((s) => ({ budget: { ...s.budget, granted: true, spentUsd: 0.0072 } }));
    addLog("🧪 Demo mode — mock data loaded, no wallet required", "ai");
    addLog("✓ Delegation simulated (Operator → Coordinator → Revoker)", "success");
    pushToast("Demo mode active — explore the full agent flow", "info");
  },

  // Re-fetch live approvals (EOA + smart account). No-op in demo mode.
  rescan: async (silent = false) => {
    const { demoMode, eoaAddress, operatorAddress, config, addLog, applyApprovals } =
      get();
    if (demoMode) {
      if (!silent) addLog("🔄 Rescan (demo) — mock approvals refreshed", "info");
      return;
    }
    // Alchemy-served chains need the key; chains without it (PulseChain) scan
    // via their public RPC, so a missing key is fine there.
    const needsKey = !!CHAINS[config.chainId]?.alchemySubdomain;
    if (!eoaAddress || (needsKey && !config.alchemyApiKey)) return;
    set({ rescanning: true });
    try {
      if (!silent) addLog("🔄 Rescanning approvals on-chain...", "info");
      // Always scan the connected EOA. Also scan the operator smart account
      // when present (Sepolia demo flow only — null on other chains).
      const scans = [
        fetchApprovals(eoaAddress, config.alchemyApiKey, config.etherscanApiKey, "eoa"),
      ];
      if (operatorAddress) {
        scans.push(
          fetchApprovals(
            operatorAddress,
            config.alchemyApiKey,
            config.etherscanApiKey,
            "smart-account"
          )
        );
      }
      const [eoaApps, saApps = []] = await Promise.all(scans);
      applyApprovals([...saApps, ...eoaApps], { alert: true });
      if (!silent) {
        const total = eoaApps.length + saApps.length;
        addLog(
          `✓ Rescan complete — ${total} active approval${total !== 1 ? "s" : ""}`,
          "success"
        );
      }
    } catch (err: any) {
      addLog(`Rescan failed: ${err?.message || err}`, "danger");
    } finally {
      set({ rescanning: false });
    }
  },

  // Switch the scan/revoke chain. Persists the choice, updates the active chain,
  // clears stale approvals, and rescans the same EOA on the new chain (the wallet
  // is switched lazily at revoke time, so scanning needs no MetaMask popup).
  changeChain: (id) => {
    const { config, walletConnected, demoMode, eoaAddress, addLog, rescan } = get();
    if (!CHAINS[id] || id === config.chainId) return;
    const next = { ...config, chainId: id };
    set({ config: next });
    saveLocal("ss-config", next);
    setActiveChain(id);
    runtime.knownApprovalIds = new Set();
    set({ approvals: [] });
    runtime.lastRescan = 0;
    addLog(`⛓️ Switched to ${CHAINS[id].label}`, "info");
    if (walletConnected && !demoMode && eoaAddress) {
      rescan(true);
    }
  },

  connect: async () => {
    const { config, addLog, refreshX402Status, applyApprovals } = get();
    setActiveChain(config.chainId);
    const cfg = getActiveChainConfig();
    try {
      set({ demoMode: false, connectionError: null });
      addLog(`Connecting MetaMask on ${cfg.label}...`, "info");

      if (!window.ethereum) {
        const msg =
          "MetaMask provider not found. Open this app in a browser with MetaMask Flask enabled.";
        addLog(msg, "danger");
        set({ connectionError: msg });
        return;
      }

      // Reset any state from a prior (possibly different-chain) connection.
      resetAccountRuntime();
      set({
        operatorAddress: null,
        agentAddress: null,
        subAgentAddress: null,
        delegationGranted: false,
      });

      if (cfg.supportsSmartAccountDemo) {
        // Sepolia: full smart-account demo flow (operator + A2A coordinator/revoker).
        const operator = await createOperatorAccount(config.alchemyApiKey);
        runtime.operatorAccount = operator.smartAccount;
        set({ eoaAddress: operator.eoaAddress, operatorAddress: operator.address });
        addLog(`Operator EOA: ${shortenAddress(operator.eoaAddress)}`, "success");
        addLog(`Smart Account: ${shortenAddress(operator.address)}`, "success");

        const agent = await createAgentAccount(config.alchemyApiKey);
        runtime.agentAccount = agent.smartAccount;
        runtime.agentPrivateKey = agent.privateKey;
        set({ agentAddress: agent.address });
        addLog(`Coordinator Agent: ${shortenAddress(agent.address)}`, "success");

        if (config.x402Enabled) {
          const x402Status = await refreshX402Status();
          if (x402Status) {
            addLog(
              `x402 payer: ${shortenAddress(x402Status.address)} · ${x402Status.balance.balanceUsd.toFixed(4)} USDC`,
              "info"
            );
            if (!x402Status.balance.canConsume) {
              addLog(
                `x402 cannot consume yet (minimum top-up ${x402Status.balance.minimumTopUpUsd} USDC)`,
                "warn"
              );
            }
          }
        }

        const subAgent = await createSubAgentAccount(config.alchemyApiKey);
        runtime.subAgentAccount = subAgent.smartAccount;
        set({ subAgentAddress: subAgent.address });
        addLog(`Revoker Sub-Agent: ${shortenAddress(subAgent.address)}`, "success");

        try {
          runtime.agent7702 = await createAgent7702Account(config.alchemyApiKey);
        } catch {
          /* relayer path optional */
        }

        set({ walletConnected: true, connectionError: null });

        // Scan live whenever we have a working RPC: an Alchemy key, or a
        // wide-range chain RPC (Infura on Sepolia) that needs no key.
        if (config.alchemyApiKey || cfg.wideRange) {
          addLog("Fetching token approvals (EOA + smart account)...", "info");
          const [eoaApps, saApps] = await Promise.all([
            fetchApprovals(
              operator.eoaAddress,
              config.alchemyApiKey,
              config.etherscanApiKey,
              "eoa"
            ),
            fetchApprovals(
              operator.address,
              config.alchemyApiKey,
              config.etherscanApiKey,
              "smart-account"
            ),
          ]);
          const apps = [...saApps, ...eoaApps];
          applyApprovals(apps);
          addLog(
            apps.length
              ? `Found ${apps.length} active approvals (${saApps.length} smart-account, ${eoaApps.length} EOA)`
              : `No active approvals found on ${cfg.label}`,
            apps.length ? "success" : "warn"
          );
        } else {
          set({ approvals: getMockApprovals() });
          addLog("No Alchemy key — loaded demo approvals", "warn");
        }
      } else {
        // mainnet / Base / Linea: scan + direct-revoke for the connected EOA.
        // Smart-account delegation / A2A / 1Shot are Sepolia-only.
        const { address } = await getWalletClient();
        set({ eoaAddress: address });
        addLog(`Connected EOA: ${shortenAddress(address)} on ${cfg.label}`, "success");
        addLog(
          "Direct revocation mode — delegation/A2A/1Shot/x402 are Sepolia-only.",
          "info"
        );
        set({ walletConnected: true, connectionError: null });

        // Alchemy-served chains need the key; PulseChain scans via its public RPC.
        const canScan = !!config.alchemyApiKey || !cfg.alchemySubdomain;
        if (canScan) {
          addLog(`Fetching token approvals on ${cfg.label}...`, "info");
          const eoaApps = await fetchApprovals(
            address,
            config.alchemyApiKey,
            config.etherscanApiKey,
            "eoa"
          );
          applyApprovals(eoaApps);
          addLog(
            eoaApps.length
              ? `Found ${eoaApps.length} active approval${eoaApps.length !== 1 ? "s" : ""} on ${cfg.label}`
              : `No active approvals found on ${cfg.label}`,
            eoaApps.length ? "success" : "warn"
          );
        } else {
          addLog("Add an Alchemy key in Settings to scan approvals.", "warn");
        }
      }
    } catch (err: any) {
      const message = err?.message || "Unknown wallet connection error";
      addLog(`Connection failed: ${message}`, "danger");
      addLog(
        `Tip: unlock MetaMask Flask, approve account access, and accept the switch to ${cfg.label}.`,
        "warn"
      );
      set({
        connectionError: message,
        walletConnected: false,
        eoaAddress: null,
        operatorAddress: null,
        agentAddress: null,
        subAgentAddress: null,
        approvals: [],
      });
    }
  },

  grantDelegation: async () => {
    const { addLog, applyApprovals } = get();
    try {
      set({ delegationError: null });
      addLog("Creating delegation with caveats...", "info");

      if (
        !runtime.operatorAccount ||
        !runtime.agentAccount ||
        !runtime.subAgentAccount
      ) {
        throw new Error(
          "Wallet/account setup incomplete. Reconnect wallet and try again."
        );
      }

      const { approvals, eoaAddress, config, budget } = get();
      let targetApprovals = approvals;
      if (
        !targetApprovals.length &&
        eoaAddress &&
        (config.alchemyApiKey || CHAINS[config.chainId]?.wideRange)
      ) {
        addLog("No approvals cached — refreshing approvals before delegation...", "warn");
        targetApprovals = await fetchApprovals(
          eoaAddress,
          config.alchemyApiKey,
          config.etherscanApiKey
        );
        applyApprovals(targetApprovals);
      }
      const allowedTargets = targetApprovals.length
        ? [...new Set(targetApprovals.map((a) => a.tokenAddress))]
        : DEFAULT_SCOPE_TARGETS;
      if (!targetApprovals.length) {
        addLog(
          "No active approvals found via RPC — using default Sepolia token scope for delegation.",
          "warn"
        );
      }

      // 1. Operator → Coordinator (root delegation, signed via MetaMask)
      const rootDelegation = await createAgentDelegation(
        runtime.operatorAccount,
        runtime.agentAccount.address,
        { allowedTargets, maxCalls: 10, expiryDays: 30 }
      );
      addLog("✓ Root delegation signed via MetaMask (Operator → Coordinator)", "success");

      // 2. Coordinator → Revoker (redelegation, signed locally — A2A handoff)
      addLog("🤝 A2A: Coordinator re-delegating to Revoker sub-agent...", "ai");
      const childDelegation = await createRedelegation(
        runtime.agentAccount,
        rootDelegation,
        runtime.subAgentAccount.address,
        { maxCalls: 5 }
      );
      addLog("✓ Redelegation signed (Coordinator → Revoker, limit 5)", "success");

      // Chain ordered leaf → root for redemption.
      runtime.delegationChain = [childDelegation, rootDelegation];

      // Deploy the Operator + Coordinator now (human present for these wallet
      // txs). The DelegationManager validates each delegator's signature via
      // ERC-1271, which needs on-chain code; an undeployed Coordinator reverts
      // redemption with InvalidEOASignature(). Doing it here keeps autonomous
      // kills popup-free. The Revoker self-deploys via its UserOp factory on the
      // Pimlico path; on the 1Shot path it isn't a delegator, so it's not needed.
      try {
        addLog("Deploying Operator + Coordinator smart accounts (one-time)...", "ai");
        const opDeploy = await ensureSmartAccountDeployed(
          runtime.operatorAccount,
          config.alchemyApiKey
        );
        const coDeploy = await ensureSmartAccountDeployed(
          runtime.agentAccount,
          config.alchemyApiKey
        );
        addLog(
          `✓ Accounts deployed (operator: ${opDeploy === "already" ? "already" : "new"}, coordinator: ${coDeploy === "already" ? "already" : "new"})`,
          "success"
        );
      } catch (deployErr: any) {
        addLog(
          `⚠ Agent account deploy failed: ${deployErr?.message || deployErr}. Delegated revocation will revert until the Coordinator is deployed.`,
          "warn"
        );
      }

      // Read remaining redemptions from the on-chain LimitedCalls enforcer.
      try {
        const left = await getDelegationUsesLeft(rootDelegation, 10, config.alchemyApiKey);
        set({ delegationUsesLeft: left });
      } catch {
        /* enforcer not yet deployed/used — keep default */
      }

      // 3. x402 budget: operator signs a revocable off-chain spend mandate.
      // NOT redeemed and NOT enforced on-chain — x402 settles via ERC-3009
      // (bypasses the DelegationManager). The cap below is a client-side guard.
      // Only needed when x402 paid inference is enabled — otherwise this is a
      // second, pointless MetaMask signature, so we skip it.
      if (config.x402Enabled) {
        const capUnits = BigInt(Math.round(budget.capUsd * 10 ** USDC_DECIMALS));
        runtime.budgetDelegation = await createBudgetDelegation(
          runtime.operatorAccount,
          runtime.agentAccount.address,
          { maxAmount: capUnits }
        );
        set((s) => ({ budget: { ...s.budget, granted: true } }));
        addLog(
          `✓ x402 spend mandate signed: ${budget.capUsd} USDC cap (off-chain, client-enforced)`,
          "success"
        );
      }

      set({ delegationGranted: true });
      addLog(
        "✓ Caveats: functionCall=approve(addr,0), LimitedCalls, 30d expiry",
        "success"
      );
    } catch (err: any) {
      const message = err?.message || "Unknown delegation error";
      set({ delegationGranted: false, delegationError: message });
      addLog(`Delegation error: ${message}`, "danger");
      if (message.includes("User rejected")) {
        addLog("Delegation signature was rejected in MetaMask.", "warn");
      } else if (message.includes("active approvals")) {
        addLog("Create a Sepolia approval first, then retry delegation.", "warn");
      } else {
        addLog(
          "Tip: ensure MetaMask Flask is on Sepolia and accept the signature prompts.",
          "warn"
        );
      }
    }
  },

  analyze: async (opts) => {
    const { addLog, pushToast, refreshX402Status } = get();
    const setUnavailable = (reason: string) => {
      set({ veniceResult: createUnavailableAnalysis(reason) });
      addLog(`⚠ Analysis unavailable — ${reason}`, "warn");
    };
    const getErrMsg = (err: unknown): string =>
      err instanceof Error && err.message ? err.message : String(err);
    const explainAnalysisError = (msg: string): string => {
      if (msg.includes("Venice API 402")) {
        return "Venice returned 402 (insufficient API credits/quota). Top up Venice API credits or enable x402 with funded USDC.";
      }
      if (msg.includes("Venice API 401")) {
        return "Venice returned 401 (invalid API key). Re-enter a fresh Venice API key in Settings.";
      }
      if (msg.includes("429")) {
        return "Provider rate-limited this request (429). Wait a few seconds and retry.";
      }
      return msg;
    };

    set({ analyzing: true, veniceResult: null });

    const { config, demoMode } = get();
    const isVision = !!opts.imageBase64;
    const requestedModel = isVision ? VISION_MODEL : TEXT_MODEL;
    const x402Active = config.x402Enabled && !!runtime.agentPrivateKey;
    set({
      analysisModelLabel: `${requestedModel} (requested via ${x402Active ? "x402" : "API key"})`,
    });
    addLog(`🧠 Venice AI analysis (${isVision ? "vision" : "text"})...`, "ai");

    // Demo mode: produce a deterministic, evidence-grounded mock verdict so
    // the analysis UX works with no API key / wallet.
    if (demoMode) {
      set({ analysisModelLabel: `${requestedModel} (demo)` });
      await new Promise((r) => setTimeout(r, 900));
      const result = createDemoAnalysis(opts);
      set({ veniceResult: result });
      const isInconclusive = !result.is_phishing && result.confidence < 35;
      addLog(
        isInconclusive
          ? `⚠ Inconclusive — ${result.confidence}% confidence`
          : result.is_phishing
          ? `🚨 PHISHING — ${result.confidence}% confidence${result.brand_impersonated ? ` (${result.brand_impersonated})` : ""}`
          : `✓ Clean — ${result.confidence}% benign`,
        isInconclusive ? "warn" : result.is_phishing ? "danger" : "success"
      );
      if (result.is_phishing) {
        pushToast(`Phishing detected — ${result.confidence}% confidence`, "danger");
      }
      set({ analyzing: false });
      return;
    }

    // x402 path: agent pays per-inference in USDC on Base (no API key).
    // The operator's signed spend mandate is enforced here client-side; the
    // ERC-3009 settlement itself is not gated on-chain by the enforcer.
    if (x402Active) {
      const x402PrivateKey = runtime.agentPrivateKey;
      if (!x402PrivateKey) {
        setUnavailable("x402 is enabled but payer wallet key is unavailable");
        set({ analyzing: false });
        return;
      }
      let shouldFallbackToApiKey = false;
      const x402Status = await refreshX402Status();
      if (x402Status && !x402Status.balance.canConsume) {
        addLog(
          `x402 balance low for payer ${shortenAddress(x402Status.address)} (min top-up ${x402Status.balance.minimumTopUpUsd} USDC)`,
          "warn"
        );
      }
      const { budget } = get();
      if (budget.spentUsd >= budget.capUsd) {
        addLog(
          `⛔ x402 cap reached (${budget.capUsd} USDC) — client-side spend guard blocks further inference`,
          "danger"
        );
        setUnavailable("x402 budget cap reached");
        set({ analyzing: false });
        return;
      }
      try {
        addLog("💸 Paying Venice via x402 (USDC on Base)...", "ai");
        const response = await analyzeViaX402(x402PrivateKey, opts);
        const { analysis, spentUsd, balanceAfter, modelUsed } = response;
        set({ veniceResult: analysis });
        if (modelUsed) {
          set({ analysisModelLabel: `${modelUsed} (x402)` });
        }
        set((s) => ({ budget: { ...s.budget, spentUsd: s.budget.spentUsd + spentUsd } }));
        addLog(
          `✓ x402 paid ${spentUsd ? spentUsd.toFixed(4) : "~0.003"} USDC · balance ${balanceAfter.toFixed(3)}`,
          "success"
        );
        const isInconclusive = !analysis.is_phishing && analysis.confidence < 35;
        addLog(
          isInconclusive
            ? `⚠ Inconclusive — ${analysis.confidence}% confidence`
            : analysis.is_phishing
            ? `🚨 PHISHING — ${analysis.confidence}% confidence${analysis.brand_impersonated ? ` (${analysis.brand_impersonated})` : ""}`
            : `✓ Clean — ${analysis.confidence}% benign`,
          isInconclusive ? "warn" : analysis.is_phishing ? "danger" : "success"
        );
        if (analysis.is_phishing) {
          pushToast(`Phishing detected — ${analysis.confidence}% confidence`, "danger");
        }
      } catch (err: any) {
        addLog(`x402 error: ${err.message}`, "danger");
        const status = await refreshX402Status();
        if (status && !status.balance.canConsume) {
          addLog(
            `x402 requires at least ${status.balance.minimumTopUpUsd.toFixed(2)} USDC spendable balance for payer ${shortenAddress(status.address)}`,
            "warn"
          );
        }
        if (config.veniceApiKey) {
          shouldFallbackToApiKey = true;
          set({ analysisModelLabel: `${requestedModel} (fallback via API key)` });
          addLog("Retrying analysis via Venice API key...", "warn");
        } else {
          setUnavailable(
            `x402 request failed and no Venice API key is configured (${explainAnalysisError(
              getErrMsg(err)
            )})`
          );
          const { x402WalletAddress } = get();
          if (x402WalletAddress) {
            addLog(
              `Fund x402 payer ${shortenAddress(x402WalletAddress)} with USDC on Base for paid inference.`,
              "warn"
            );
          }
        }
      }
      if (!shouldFallbackToApiKey) {
        set({ analyzing: false });
        return;
      }
    }

    if (config.veniceApiKey) {
      set({ analysisModelLabel: `${requestedModel} (API key)` });
      try {
        const response = isVision
          ? await analyzeScreenshotDetailed(
              config.veniceApiKey,
              opts.imageBase64!,
              opts.context
            )
          : await analyzeUrlDetailed(config.veniceApiKey, opts.context || "");

        const result = response.analysis;
        if (response.modelUsed) {
          set({ analysisModelLabel: `${response.modelUsed} (API key)` });
        }

        set({ veniceResult: result });
        const isInconclusive = !result.is_phishing && result.confidence < 35;
        addLog(
          isInconclusive
            ? `⚠ Inconclusive — ${result.confidence}% confidence`
            : result.is_phishing
            ? `🚨 PHISHING — ${result.confidence}% confidence${
                result.brand_impersonated ? ` (${result.brand_impersonated})` : ""
              }`
            : `✓ Clean — ${result.confidence}% benign`,
          isInconclusive ? "warn" : result.is_phishing ? "danger" : "success"
        );
        if (result.is_phishing) {
          pushToast(`Phishing detected — ${result.confidence}% confidence`, "danger");
        }
      } catch (err: any) {
        addLog(`Venice error: ${err.message}`, "danger");
        setUnavailable(`Venice API request failed (${explainAnalysisError(getErrMsg(err))})`);
      }
    } else {
      setUnavailable("No Venice provider configured (enable x402 or add API key)");
    }
    set({ analyzing: false });
  },

  analyzeThreat: (threat) => {
    set({ selectedThreat: threat });
    const exposureLine =
      threat.exposureUsd === null
        ? "UNKNOWN (balance or price unreadable)"
        : `$${threat.exposureUsd.toFixed(2)} drainable now (min(wallet balance, allowance) × price)`;
    get().analyze({
      context: `Analyze this token approval for phishing risk:
Token: ${threat.token} (${threat.tokenAddress})
Spender: ${threat.spender}
Spender Label: ${threat.spenderLabel || "UNKNOWN"}
Amount: ${threat.amount}
Max Approval: ${threat.isMaxApproval}
Contract Age: ${threat.contractAge} days
Verified Source: ${threat.verified}
Dollar Exposure: ${exposureLine}
Heuristic Risk Score: ${threat.riskScore}/100`,
    });
  },

  kill: async (approval) => {
    const { addLog, pushToast } = get();
    // Capture the verdict shown at kill time (matches the pre-refactor closure).
    const { veniceResult, config, demoMode } = get();
    set({ killAnimation: approval.id });
    addLog(
      `🗡️ KILL — Revoking ${approval.token} to ${shortenAddress(approval.spender)}`,
      "danger"
    );

    // Demo mode: simulate the ERC-7710 redemption without touching the chain.
    if (demoMode) {
      await new Promise((r) => setTimeout(r, 700));
      set((s) => ({ approvals: s.approvals.filter((a) => a.id !== approval.id) }));
      const demoKill: Kill = {
        id: crypto.randomUUID(),
        token: approval.token,
        spender: approval.spender,
        threat: veniceResult?.brand_impersonated
          ? `Phishing: ${veniceResult.brand_impersonated}`
          : "Malicious Approval",
        confidence: veniceResult?.confidence || approval.riskScore,
        timestamp: Date.now(),
        txHash: `0x${crypto.randomUUID().replace(/-/g, "")}${"0".repeat(32)}`.slice(0, 66) as Hex,
      };
      set((s) => {
        const updated = [demoKill, ...s.kills];
        saveLocal("ss-kills", updated);
        return { kills: updated };
      });
      set((s) => ({
        delegationUsesLeft: Math.max(0, s.delegationUsesLeft - 1),
        killAnimation: null,
        selectedThreat: null,
        veniceResult: null,
      }));
      addLog("✓ [demo] Approval revoked via simulated ERC-7710 redemption", "success");
      pushToast(`Revoked ${approval.token} approval`, "success");
      return;
    }

    // Attempt real on-chain revocation.
    let realTxHash: Hex | null = null;
    let attempted = false;

    // Ground truth: confirm the on-chain allowance for THIS approval's owner is
    // actually zero before reporting success. A submitted/relayed tx is NOT
    // proof of revocation.
    const owner = approval.owner;
    const verifyRevoked = async (): Promise<boolean> => {
      try {
        const remaining = await readAllowance(
          approval.tokenAddress,
          owner,
          approval.spender,
          config.alchemyApiKey
        );
        return remaining === 0n;
      } catch (err: any) {
        addLog(`Could not verify allowance on-chain: ${err?.message || err}`, "warn");
        return false;
      }
    };

    let confirmedRevoked = false;

    if (approval.ownerType === "smart-account") {
      // Autonomous path: the delegated Revoker sub-agent redeems the ERC-7710
      // chain, executing approve(spender, 0) AS the operator smart account
      // (the approval owner) — no human in the loop.
      if (
        config.relayerMode === "1shot" &&
        runtime.agent7702 &&
        runtime.agentAccount &&
        runtime.delegationChain.length === 2
      ) {
        attempted = true;
        try {
          const a = runtime.agent7702;
          // The relayer redeems the operator-rooted chain (the coordinator
          // redelegates to the relayer's wallet inside revokeViaRelayer), so
          // approve(spender, 0) executes FROM the operator smart account.
          // The agent's 7702 account only pays the USDC gas fee.
          const result = await revokeViaRelayer({
            chainId: getChainId(),
            smartAccount: a.smartAccount,
            eoaAccount: a.eoaAccount,
            publicClient: a.smartAccount.client,
            statelessImpl: a.statelessImpl,
            coordinatorAccount: runtime.agentAccount,
            rootDelegation: runtime.delegationChain[1],
            tokenAddress: approval.tokenAddress,
            spender: approval.spender,
            upgrade: !runtime.agent7702Upgraded,
            destinationUrl: config.webhookUrl || undefined,
            onLog: (m) => addLog(m, "ai"),
          });
          runtime.agent7702Upgraded = true;
          realTxHash = result.txHash;
          addLog(
            `1Shot relay ${result.status} — gas ${result.feeUsdc} USDC${result.txHash ? ` · ${shortenAddress(result.txHash)}` : ""}`,
            result.status === "confirmed" ? "success" : "warn"
          );
        } catch (err: any) {
          addLog(`1Shot relay failed: ${err.message}`, "danger");
        }
      } else if (
        runtime.subAgentAccount &&
        runtime.delegationChain.length &&
        config.pimlicoApiKey
      ) {
        attempted = true;
        try {
          const bundlerUrl = `https://api.pimlico.io/v2/sepolia/rpc?apikey=${config.pimlicoApiKey}`;
          addLog("🤝 Revoker redeeming delegation chain (autonomous)...", "ai");
          realTxHash = await executeRevocation(
            runtime.subAgentAccount,
            runtime.delegationChain,
            approval.tokenAddress,
            approval.spender,
            bundlerUrl
          );
          addLog(`✓ Revocation UserOp mined: ${shortenAddress(realTxHash)}`, "success");
        } catch (err: any) {
          addLog(`Delegated revocation failed: ${err.message}`, "danger");
        }
      } else {
        addLog(
          "No delegated revocation path available — grant the delegation first, then set a Pimlico key or use 1Shot.",
          "danger"
        );
      }
      confirmedRevoked = attempted ? await verifyRevoked() : false;
    } else {
      // EOA-owned approval: only the owner wallet can zero its own allowance,
      // so revoke directly via MetaMask (requires a signature).
      attempted = true;
      try {
        addLog("Revoking EOA-owned approval directly from your wallet...", "ai");
        const directHash = await revokeApprovalDirect(
          approval.tokenAddress,
          approval.spender,
          config.alchemyApiKey
        );
        realTxHash = directHash;
        addLog(`✓ Direct revocation tx mined: ${shortenAddress(directHash)}`, "success");
        confirmedRevoked = await verifyRevoked();
      } catch (err: any) {
        addLog(`Direct revocation failed: ${err?.message || err}`, "danger");
      }
    }

    if (!confirmedRevoked) {
      set({ killAnimation: null });
      if (attempted) {
        addLog(
          "✗ Revocation not confirmed — approval remains active and was kept in the list.",
          "danger"
        );
        pushToast(`Revocation of ${approval.token} not confirmed`, "danger");
      }
      return;
    }

    // Confirmed revoked on-chain: now (and only now) update UI + record the kill.
    set((s) => ({ approvals: s.approvals.filter((a) => a.id !== approval.id) }));
    const newKill: Kill = {
      id: crypto.randomUUID(),
      token: approval.token,
      spender: approval.spender,
      threat: veniceResult?.brand_impersonated
        ? `Phishing: ${veniceResult.brand_impersonated}`
        : "Malicious Approval",
      confidence: veniceResult?.confidence || 0,
      timestamp: Date.now(),
      txHash: realTxHash,
    };
    set((s) => {
      const updated = [newKill, ...s.kills];
      saveLocal("ss-kills", updated);
      return { kills: updated };
    });
    set((s) => ({ delegationUsesLeft: Math.max(0, s.delegationUsesLeft - 1) }));
    // Reconcile with the on-chain enforcer once the redemption settles.
    const root = runtime.delegationChain[1];
    if (root) {
      getDelegationUsesLeft(root, 10, config.alchemyApiKey)
        .then((left) => set({ delegationUsesLeft: left }))
        .catch(() => {});
    }
    set({ killAnimation: null, selectedThreat: null, veniceResult: null });
    addLog("✓ Approval revoked — on-chain allowance confirmed 0", "success");
    pushToast(`Revoked ${approval.token} — allowance now 0`, "success");
  },

  // Autonomous Kill Mode: revoke every approval whose heuristic risk meets the
  // threshold, with no per-item click. This is the agent's headline behavior —
  // "no human in the loop for the kill" — bounded by the signed ERC-7710 chain.
  sweep: async (opts = {}) => {
    const { manual } = opts;
    const { addLog, pushToast, kill } = get();
    if (runtime.sweeping) {
      if (manual) {
        addLog("🤖 Sweep already running…", "warn");
        pushToast("Sweep already running…", "warn");
      }
      return;
    }
    // A manual "Sweep Now" click revokes every current approval at/above the
    // threshold, including ones a prior (failed) attempt touched. The automatic
    // loop skips already-attempted ids via runtime.sweptIds so it can't spin forever.
    const { approvals, autoThreshold } = get();
    const targets = approvals.filter(
      (a) => a.riskScore >= autoThreshold && (manual || !runtime.sweptIds.has(a.id))
    );
    if (!targets.length) {
      if (manual) {
        const msg = approvals.length
          ? `Nothing to sweep — no approvals at/above risk ${autoThreshold}. Lower the Threshold slider to include more.`
          : "Nothing to sweep — no active approvals detected yet.";
        addLog(`🤖 ${msg}`, "warn");
        pushToast(msg, "warn");
      }
      return;
    }
    runtime.sweeping = true;
    addLog(
      `🤖 ${manual ? "Manual" : "Autonomous"} sweep — ${targets.length} target${targets.length !== 1 ? "s" : ""} ≥ ${autoThreshold} risk`,
      "ai"
    );
    pushToast(`Sweeping ${targets.length} threat${targets.length !== 1 ? "s" : ""}…`, "warn");
    for (const t of targets) {
      runtime.sweptIds.add(t.id);
      addLog(
        `🤖 Auto-revoking ${t.token} (risk ${t.riskScore}) → ${shortenAddress(t.spender)}`,
        "danger"
      );
      // eslint-disable-next-line no-await-in-loop
      await kill(t);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 400));
    }
    runtime.sweeping = false;
  },

  createTestApproval: async (spender) => {
    const { addLog, applyApprovals } = get();
    const spenderAddr = spender.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(spenderAddr)) {
      addLog("Enter a valid spender address (0x…40 hex).", "warn");
      return;
    }
    if (!runtime.operatorAccount) {
      addLog("Connect your wallet first.", "warn");
      return;
    }
    const { config, operatorAddress, eoaAddress } = get();
    if (!config.pimlicoApiKey) {
      addLog("A Pimlico key is required to send the approval UserOp.", "danger");
      return;
    }
    set({ creatingApproval: true });
    try {
      addLog(
        `Creating smart-account test approval → ${shortenAddress(spenderAddr)} (sign UserOp in MetaMask)...`,
        "ai"
      );
      const bundlerUrl = `https://api.pimlico.io/v2/sepolia/rpc?apikey=${config.pimlicoApiKey}`;
      const hash = await createSmartAccountApproval(
        runtime.operatorAccount,
        TEST_USDC_SEPOLIA,
        spenderAddr as Address,
        bundlerUrl
      );
      addLog(`✓ Smart-account approval created: ${shortenAddress(hash)}`, "success");
      if (
        operatorAddress &&
        eoaAddress &&
        (config.alchemyApiKey || CHAINS[config.chainId]?.wideRange)
      ) {
        const [eoaApps, saApps] = await Promise.all([
          fetchApprovals(eoaAddress, config.alchemyApiKey, config.etherscanApiKey, "eoa"),
          fetchApprovals(
            operatorAddress,
            config.alchemyApiKey,
            config.etherscanApiKey,
            "smart-account"
          ),
        ]);
        applyApprovals([...saApps, ...eoaApps], { alert: true });
      }
    } catch (err: any) {
      addLog(`Create approval failed: ${err?.message || err}`, "danger");
      addLog(
        "Most common cause: the operator smart account has no Sepolia ETH for gas.",
        "warn"
      );
    }
    set({ creatingApproval: false });
  },

  // Seed real mock-malicious approvals on Sepolia from the connected EOA: deploy
  // a fresh unverified spender, then grant unlimited (MAX) approvals to it across
  // several Sepolia ERC-20s. These appear as EOA-owned threats (unlimited →
  // unknown, unverified, brand-new spender) and are directly revocable. Live
  // only; each step is a MetaMask signature paid from the connected wallet.
  seedMaliciousApprovals: async () => {
    const { addLog, pushToast, config, eoaAddress, demoMode, rescan } = get();
    if (demoMode) {
      addLog("Seeding is live-only — connect a real Sepolia wallet.", "warn");
      return;
    }
    if (!eoaAddress) {
      addLog("Connect your wallet first.", "warn");
      return;
    }
    if (!CHAINS[config.chainId]?.supportsSmartAccountDemo) {
      addLog("Seeding malicious approvals is wired for Sepolia only.", "warn");
      return;
    }
    // Sepolia ERC-20s the app already scopes/scans.
    const tokens: { sym: string; addr: Address }[] = [
      { sym: "USDC", addr: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
      { sym: "WETH", addr: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9" },
      { sym: "LINK", addr: "0x779877A7B0D9E8603169DdbD7836e478b4624789" },
    ];
    set({ seeding: true });
    try {
      addLog("🩸 Deploying fresh malicious spender (sign in MetaMask)...", "ai");
      const spender = await deployMaliciousSpender(config.alchemyApiKey);
      addLog(`✓ Spender deployed: ${shortenAddress(spender)} (unverified, brand new)`, "success");
      pushToast(`Malicious spender deployed ${shortenAddress(spender)}`, "warn");

      for (const t of tokens) {
        addLog(`🩸 Approving MAX ${t.sym} → ${shortenAddress(spender)} (sign in MetaMask)...`, "ai");
        try {
          const hash = await createEoaMaxApproval(t.addr, spender, config.alchemyApiKey);
          addLog(`✓ ${t.sym} unlimited approval set — ${shortenAddress(hash)}`, "danger");
        } catch (err: any) {
          addLog(`${t.sym} approval failed: ${err?.message || err}`, "warn");
        }
      }

      addLog("🩸 Seeded malicious approvals — rescanning to surface threats...", "ai");
      await rescan(false);
      pushToast("Malicious approvals seeded — scan shows new threats", "danger");
    } catch (err: any) {
      addLog(`Seed failed: ${err?.message || err}`, "danger");
      addLog("Most common cause: the connected wallet has no Sepolia ETH for gas.", "warn");
    } finally {
      set({ seeding: false });
    }
  },

  // Scan loop tick — drives the progress bar AND triggers a real on-chain rescan
  // on each completed cycle (throttled), so "scanning" reflects live state
  // instead of being purely cosmetic.
  runScanTick: () => {
    const { scanProgress, approvals, demoMode, addLog, rescan } = get();
    if (scanProgress >= 100) {
      const threats = approvals.filter((a) => a.riskScore > 75).length;
      addLog(
        threats > 0
          ? `⚠ Scan — ${threats} threat${threats !== 1 ? "s" : ""} active`
          : "✓ Scan — no new threats",
        threats > 0 ? "warn" : "success"
      );
      // Real rescan at most once every 45s to respect RPC rate limits.
      if (!demoMode && Date.now() - runtime.lastRescan > 45_000) {
        runtime.lastRescan = Date.now();
        rescan(true);
      }
      set({ scanProgress: 0 });
    } else {
      set({ scanProgress: scanProgress + Math.random() * 3 });
    }
  },
}));

/**
 * chains.ts — multichain registry + active-chain state.
 *
 * Scam Slayer scans approvals and performs direct EOA revocations (approve→0 via
 * MetaMask) on whichever chain is selected. The smart-account demo flow
 * (ERC-7710 delegation, A2A redelegation, 1Shot relayer, the "create test
 * approval" helper) is wired for Sepolia only — chains without
 * `supportsSmartAccountDemo` still get full scan + direct-revoke.
 *
 * This module owns the single source of truth for the active chain so wallet,
 * scanner, and UI all agree.
 */

import { mainnet, sepolia, base, linea, pulsechain, bsc, polygon } from "viem/chains";
import type { Chain } from "viem";
import { getProxyUrl } from "./proxy";

export interface ChainConfig {
  id: number;
  chain: Chain;
  label: string;
  /**
   * Alchemy network subdomain, e.g. "eth-mainnet". `null` for chains Alchemy
   * doesn't serve (e.g. PulseChain) — those always use `publicRpc`.
   */
  alchemySubdomain: string | null;
  /** Public RPC, used when no Alchemy key is set OR Alchemy doesn't serve the chain. */
  publicRpc: string;
  /**
   * RPC serves wide `eth_getLogs` block ranges in a single request (e.g. Infura),
   * so the scanner does a deep one-shot scan instead of relying on an Alchemy key.
   * Falsy chains fall back to the rate-capped shallow scan unless an Alchemy key
   * is present. The chunker still adapts down if a provider rejects the range.
   */
  wideRange?: boolean;
  /** Block explorer base URL (no trailing slash). */
  explorer: string;
  /**
   * Whether the smart-account demo flow (delegation grant / A2A / 1Shot /
   * create-test-approval) is wired for this chain. Direct EOA revocation works
   * regardless.
   */
  supportsSmartAccountDemo: boolean;
}

// Etherscan v2 uses ONE API host + an explicit chainid, so a single Etherscan
// key covers every chain below.
export const ETHERSCAN_V2_API = "https://api.etherscan.io/v2/api";

// Optional Infura key (build-time env only — NEVER hardcode a key here; this
// repo is public). When set, Infura serves wide eth_getLogs ranges in one
// request (no Alchemy free-tier 10-block cap), so Infura-backed chains are
// marked wideRange. When unset (e.g. the public GitHub Pages build), chains fall
// back to a keyless public RPC below; live scanning then works best with a
// user-supplied Alchemy key (Settings) or a configured secret proxy
// (VITE_PROXY_URL). DEMO mode needs no RPC at all. Override per-chain with the
// VITE_<CHAIN>_RPC env vars.
const INFURA_KEY = import.meta.env.VITE_INFURA_KEY || "";

// Keyless, CORS-enabled public RPCs used when no Infura key is configured.
function rpcFor(infuraNet: string, publicRpc: string): string {
  return INFURA_KEY ? `https://${infuraNet}.infura.io/v3/${INFURA_KEY}` : publicRpc;
}

export const CHAINS: Record<number, ChainConfig> = {
  [sepolia.id]: {
    id: sepolia.id,
    chain: sepolia,
    label: "Sepolia",
    // Infura serves wide eth_getLogs ranges (full deep scan in one request),
    // unlike Alchemy's free tier (10-block cap). Routed here regardless of any
    // Alchemy key so scanning Just Works. Override with VITE_SEPOLIA_RPC.
    alchemySubdomain: null,
    publicRpc:
      import.meta.env.VITE_SEPOLIA_RPC ||
      rpcFor("sepolia", "https://ethereum-sepolia-rpc.publicnode.com"),
    wideRange: true,
    explorer: "https://sepolia.etherscan.io",
    supportsSmartAccountDemo: true,
  },
  [mainnet.id]: {
    id: mainnet.id,
    chain: mainnet,
    label: "Ethereum",
    alchemySubdomain: null,
    publicRpc:
      import.meta.env.VITE_MAINNET_RPC ||
      rpcFor("mainnet", "https://ethereum-rpc.publicnode.com"),
    wideRange: true,
    explorer: "https://etherscan.io",
    supportsSmartAccountDemo: false,
  },
  [base.id]: {
    id: base.id,
    chain: base,
    label: "Base",
    alchemySubdomain: null,
    publicRpc:
      import.meta.env.VITE_BASE_RPC ||
      rpcFor("base-mainnet", "https://base-rpc.publicnode.com"),
    wideRange: true,
    explorer: "https://basescan.org",
    supportsSmartAccountDemo: false,
  },
  [linea.id]: {
    id: linea.id,
    chain: linea,
    label: "Linea",
    alchemySubdomain: null,
    publicRpc:
      import.meta.env.VITE_LINEA_RPC ||
      rpcFor("linea-mainnet", "https://linea-rpc.publicnode.com"),
    wideRange: true,
    explorer: "https://lineascan.build",
    supportsSmartAccountDemo: false,
  },
  [bsc.id]: {
    id: bsc.id,
    chain: bsc,
    label: "BNB Chain",
    alchemySubdomain: null,
    publicRpc:
      import.meta.env.VITE_BSC_RPC ||
      rpcFor("bsc-mainnet", "https://bsc-rpc.publicnode.com"),
    wideRange: true,
    explorer: "https://bscscan.com",
    supportsSmartAccountDemo: false,
  },
  [polygon.id]: {
    id: polygon.id,
    chain: polygon,
    label: "Polygon",
    alchemySubdomain: null,
    publicRpc:
      import.meta.env.VITE_POLYGON_RPC ||
      rpcFor("polygon-mainnet", "https://polygon-bor-rpc.publicnode.com"),
    wideRange: true,
    explorer: "https://polygonscan.com",
    supportsSmartAccountDemo: false,
  },
  [pulsechain.id]: {
    id: pulsechain.id,
    chain: pulsechain,
    label: "PulseChain",
    // Not served by Alchemy — always uses the public RPC below.
    alchemySubdomain: null,
    publicRpc: "https://rpc.pulsechain.com",
    explorer: "https://scan.pulsechain.com",
    supportsSmartAccountDemo: false,
  },
};

export const CHAIN_LIST: ChainConfig[] = Object.values(CHAINS);
export const DEFAULT_CHAIN_ID = sepolia.id;

// ---- Active chain (module-level, single source of truth) ----

let activeChainId: number = DEFAULT_CHAIN_ID;

export function setActiveChain(id: number): void {
  if (CHAINS[id]) activeChainId = id;
}

export function getActiveChainConfig(): ChainConfig {
  return CHAINS[activeChainId] ?? CHAINS[DEFAULT_CHAIN_ID];
}

export function getChain(): Chain {
  return getActiveChainConfig().chain;
}

export function getChainId(): number {
  return getActiveChainConfig().id;
}

export function isChainSupported(id: number): boolean {
  return !!CHAINS[id];
}

// Hard RPC override — wins over proxy/alchemy/public. Used by the Anvil-fork
// integration test to point reads at a local fork; null in normal operation.
let rpcOverride: string | null = null;

export function setRpcOverride(url: string | null): void {
  rpcOverride = url;
}

/**
 * Resolve the JSON-RPC URL for the active chain. Precedence:
 *   1. explicit override (integration tests)
 *   2. secret proxy (VITE_PROXY_URL → worker holds the keys)
 *   3. Alchemy (when a key is set AND the chain is Alchemy-served)
 *   4. the chain's public RPC
 */
export function getRpcUrl(alchemyKey?: string): string {
  if (rpcOverride) return rpcOverride;
  const cfg = getActiveChainConfig();
  const proxy = getProxyUrl();
  if (proxy) return `${proxy}/rpc/${cfg.id}`;
  return alchemyKey && cfg.alchemySubdomain
    ? `https://${cfg.alchemySubdomain}.g.alchemy.com/v2/${alchemyKey}`
    : cfg.publicRpc;
}

export function explorerAddress(addr: string): string {
  return `${getActiveChainConfig().explorer}/address/${addr}`;
}

export function explorerTx(hash: string): string {
  return `${getActiveChainConfig().explorer}/tx/${hash}`;
}

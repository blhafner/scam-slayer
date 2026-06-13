import type { Address, Hex } from "viem";

// ---- Config ----
export interface AppConfig {
  // Selected EVM chain id for scanning + direct revocation (mainnet/Base/Linea/Sepolia).
  chainId: number;
  veniceApiKey: string;
  alchemyApiKey: string;
  pimlicoApiKey: string;
  // Optional — enables real contract age + source-verification lookups.
  etherscanApiKey: string;
  // When true, the agent pays Venice per-inference via x402 (USDC on Base)
  // instead of using a shared API key.
  x402Enabled: boolean;
  // Revocation execution path: Pimlico bundler (ETH gas) or the 1Shot
  // permissionless relayer (gas paid in USDC, EIP-7702 upgrade).
  relayerMode: "pimlico" | "1shot";
  // Optional webhook endpoint for 1Shot relayer status events.
  webhookUrl: string;
}

// ---- x402 intelligence budget (operator-signed mandate, client-enforced) ----
export interface BudgetState {
  // Operator-granted spend cap, in USDC. Enforced client-side (not on-chain).
  capUsd: number;
  // USDC spent on x402 inference so far.
  spentUsd: number;
  granted: boolean;
}

// ---- Wallet / Accounts ----
export interface WalletState {
  isConnected: boolean;
  address: Address | null;
  chainId: number | null;
}

export interface AgentAccount {
  address: Address;
  privateKey: Hex;
}

// ---- Delegation ----
export interface DelegationState {
  isGranted: boolean;
  delegationHash: Hex | null;
  grantedAt: number | null;
  expiresAt: number | null;
  usesLeft: number;
  maxUses: number;
}

// ---- Approvals ----
export interface TokenApproval {
  id: string;
  token: string;
  tokenAddress: Address;
  spender: Address;
  spenderLabel: string | null;
  amount: string;
  isMaxApproval: boolean;
  riskScore: number;
  // Human-readable signals that drove the risk score (shown in the UI so the
  // verdict is explainable, not a black-box number).
  riskFactors: string[];
  contractAge: number; // days
  verified: boolean;
  // Dollar-at-risk: min(wallet balance, allowance) × token price. What this
  // approval can drain RIGHT NOW. null = unknown (balance/price not readable),
  // never fabricated.
  exposureUsd: number | null;
  // Token units at risk (min(balance, allowance), human units). null = unknown.
  exposureTokens: number | null;
  // USD price used for the exposure calc. null = no price source for token.
  priceUsd: number | null;
  status: "safe" | "threat" | "analyzing" | "revoked";
  // The account that granted this approval. Determines how it can be revoked:
  // "eoa" → direct approve(0) from the wallet; "smart-account" → autonomous
  // revocation via the ERC-7710 delegation chain.
  owner: Address;
  ownerType: "eoa" | "smart-account";
}

// ---- Venice AI ----
export interface PhishingAnalysis {
  is_phishing: boolean;
  confidence: number;
  brand_impersonated: string | null;
  indicators: string[];
  reasoning: string;
}

// ---- Kill Log ----
export interface Kill {
  id: string;
  token: string;
  spender: Address;
  threat: string;
  confidence: number;
  timestamp: number;
  txHash: Hex | null;
}

// ---- Agent Log ----
export interface LogEntry {
  time: string;
  msg: string;
  level: "info" | "warn" | "success" | "danger" | "ai";
}

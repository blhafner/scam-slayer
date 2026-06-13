/**
 * wallet.ts — MetaMask Smart Accounts Kit integration
 *
 * Handles:
 * - Connecting to MetaMask (browser extension)
 * - Creating operator + agent smart accounts via the SDK
 * - Creating scoped delegations (ERC-7710) with caveats
 * - Signing and redeeming delegations
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  custom,
  parseAbi,
  encodeFunctionData,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

import {
  getActiveChainConfig,
  getChain,
  getChainId,
  getRpcUrl,
} from "./chains";
// Re-export so existing importers (App, scanner) keep working unchanged.
export { getChain, getChainId, setActiveChain, getActiveChainConfig } from "./chains";

// Main SDK exports
import {
  Implementation,
  toMetaMaskSmartAccount,
  getSmartAccountsEnvironment,
  createDelegation,
  createExecution,
  ExecutionMode,
} from "@metamask/smart-accounts-kit";

// Hash a delegation (keyed lookup for enforcer state)
import { hashDelegation } from "@metamask/smart-accounts-kit/utils";

// Enforcer contract for reading on-chain call counts
import { LimitedCallsEnforcer } from "@metamask/smart-accounts-kit/contracts";

// Utils subpath — caveat builder lives here
import {
  createCaveatBuilder,
} from "@metamask/smart-accounts-kit/utils";

// Contracts subpath — DelegationManager for redemption
import {
  DelegationManager,
} from "@metamask/smart-accounts-kit/contracts";

// ---- Constants ----
const AGENT_KEY_STORAGE = "scamslayer-agent-key";
const SUBAGENT_KEY_STORAGE = "scamslayer-subagent-key";

const ERC20_APPROVE_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

// USDC — the asset Venice x402 settles in on Base.
export const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const USDC_BASE_SEPOLIA: Address =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
// USDC has 6 decimals.
export const USDC_DECIMALS = 6;

// ---- Clients ----

export function getPublicClient(alchemyKey?: string) {
  const cfg = getActiveChainConfig();
  // RPC URL resolution (override → proxy → Alchemy → public) lives in chains.ts
  // so the secret proxy and the integration-test fork share one chokepoint.
  return createPublicClient({
    chain: cfg.chain,
    transport: http(getRpcUrl(alchemyKey)),
  });
}

function getMetaMaskProvider() {
  const injected = window.ethereum as
    | (Window["ethereum"] & { providers?: any[]; isMetaMask?: boolean })
    | undefined;
  if (!injected) return null;

  if (Array.isArray(injected.providers) && injected.providers.length) {
    const metaMaskProvider = injected.providers.find((provider) => provider?.isMetaMask);
    if (metaMaskProvider) return metaMaskProvider;
  }

  return injected;
}

async function ensureWalletOnActiveChain(provider: {
  request: (args: { method: string; params?: unknown[] }) => Promise<any>;
}) {
  const cfg = getActiveChainConfig();
  const chain = cfg.chain;
  const targetChainHex = `0x${chain.id.toString(16)}`;
  const currentChainHex = await provider.request({ method: "eth_chainId" });
  if (currentChainHex?.toLowerCase() === targetChainHex.toLowerCase()) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: targetChainHex }],
    });
  } catch (error: any) {
    if (error?.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: targetChainHex,
            chainName: chain.name,
            nativeCurrency: chain.nativeCurrency,
            rpcUrls: [chain.rpcUrls.default.http[0]],
            blockExplorerUrls: [chain.blockExplorers?.default?.url || cfg.explorer],
          },
        ],
      });
      return;
    }
    throw error;
  }
}

export async function getWalletClient() {
  const provider = getMetaMaskProvider();
  if (!provider) {
    throw new Error("MetaMask not detected");
  }

  const [address] = await provider.request({
    method: "eth_requestAccounts",
  });
  await ensureWalletOnActiveChain(provider);

  return {
    client: createWalletClient({
      chain: getChain(),
      transport: custom(provider),
    }),
    address: address as Address,
  };
}

// ---- Smart Account Creation ----

export async function createOperatorAccount(alchemyKey?: string) {
  const publicClient = getPublicClient(alchemyKey);
  const { client: walletClient, address: eoaAddress } = await getWalletClient();

  const smartAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [eoaAddress, [], [], []],
    deploySalt: "0x",
    signer: {
      account: {
        address: eoaAddress,
        signMessage: async ({ message }: any) =>
          walletClient.signMessage({ account: eoaAddress, message }),
        signTypedData: async (typedData: any) =>
          walletClient.signTypedData({ account: eoaAddress, ...typedData }),
      } as any,
    },
  });

  return { smartAccount, address: smartAccount.address, eoaAddress };
}

async function createLocalSmartAccount(
  storageKey: string,
  salt: Hex,
  alchemyKey?: string
) {
  const publicClient = getPublicClient(alchemyKey);

  let key = localStorage.getItem(storageKey) as Hex | null;
  if (!key) {
    key = generatePrivateKey();
    localStorage.setItem(storageKey, key);
  }

  const eoa = privateKeyToAccount(key);

  const smartAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [eoa.address, [], [], []],
    deploySalt: salt,
    signer: { account: eoa },
  });

  return { smartAccount, address: smartAccount.address, privateKey: key };
}

// Coordinator agent — receives the root delegation from the operator.
export async function createAgentAccount(alchemyKey?: string) {
  return createLocalSmartAccount(AGENT_KEY_STORAGE, "0x1", alchemyKey);
}

// Revoker sub-agent — receives a redelegation from the coordinator (A2A).
export async function createSubAgentAccount(alchemyKey?: string) {
  return createLocalSmartAccount(SUBAGENT_KEY_STORAGE, "0x2", alchemyKey);
}

/**
 * Read the locally-stored agent EOA private key, if any. This key controls the
 * x402 payer wallet — back it up before funding (it lives ONLY in this browser's
 * localStorage and is unrecoverable if cleared).
 */
export function getStoredAgentKey(): Hex | null {
  return (localStorage.getItem(AGENT_KEY_STORAGE) as Hex | null) ?? null;
}

/** Derive the agent payer EOA address from the stored key (null if none/invalid). */
export function getStoredAgentAddress(): Address | null {
  const key = getStoredAgentKey();
  if (!key) return null;
  try {
    return privateKeyToAccount(key).address;
  } catch {
    return null;
  }
}

/**
 * Restore a specific agent EOA private key into local storage — e.g. to recover
 * a previously-funded x402 payer wallet whose key was wiped or generated on a
 * different origin. Validates the key, persists it under AGENT_KEY_STORAGE, and
 * returns the derived EOA address. Throws on an invalid key.
 */
export function importAgentKey(rawKey: string): Address {
  const trimmed = rawKey.trim();
  const normalized = (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as Hex;
  // privateKeyToAccount throws if it isn't a valid 32-byte secp256k1 key.
  const account = privateKeyToAccount(normalized);
  localStorage.setItem(AGENT_KEY_STORAGE, normalized);
  return account.address;
}

/**
 * 7702 stateless-delegator representation of the agent EOA, used for the
 * 1Shot relayer path. Reuses the same agent key so the on-chain account is the
 * agent's EOA upgraded in place via EIP-7702.
 */
export async function createAgent7702Account(alchemyKey?: string) {
  const publicClient = getPublicClient(alchemyKey);

  let key = localStorage.getItem(AGENT_KEY_STORAGE) as Hex | null;
  if (!key) {
    key = generatePrivateKey();
    localStorage.setItem(AGENT_KEY_STORAGE, key);
  }
  const eoaAccount = privateKeyToAccount(key);

  const smartAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Stateless7702,
    address: eoaAccount.address,
    signer: { account: eoaAccount },
  });

  const environment = getSmartAccountsEnvironment(getChainId());

  return {
    smartAccount,
    eoaAccount,
    address: eoaAccount.address,
    statelessImpl: environment.implementations
      .EIP7702StatelessDeleGatorImpl as Address,
  };
}

// getChainId / getChain are re-exported from ./chains (see top of file).

// ---- Delegation ----

export async function createAgentDelegation(
  operatorAccount: any,
  agentAddress: Address,
  opts: {
    allowedTargets?: Address[];
    maxCalls?: number;
    expiryDays?: number;
  } = {}
) {
  const environment = getSmartAccountsEnvironment(getChainId());

  if (!opts.allowedTargets?.length) {
    throw new Error("At least one ERC-20 target required for delegation scope");
  }

  // Extra caveats layered on top of the scope: rate-limit total redemptions
  // and expire the delegation after expiryDays (default 30).
  const expirySeconds =
    Math.floor(Date.now() / 1000) + (opts.expiryDays ?? 30) * 86400;
  const extraCaveats = createCaveatBuilder(environment)
    .addCaveat("limitedCalls", { limit: opts.maxCalls ?? 10 })
    .addCaveat("timestamp", { afterThreshold: 0, beforeThreshold: expirySeconds })
    .build();

  // functionCall scope restricts to approve(address,uint256) on the given
  // ERC-20 targets only, with value=0 (no native token movement).
  const delegation = createDelegation({
    environment,
    to: agentAddress,
    from: operatorAccount.address,
    scope: {
      type: "functionCall",
      targets: opts.allowedTargets,
      selectors: ["approve(address,uint256)"],
    },
    caveats: extraCaveats,
  });

  // Sign with operator's account (triggers MetaMask popup)
  const signature = await operatorAccount.signDelegation({ delegation });

  return { ...delegation, signature };
}

/**
 * A2A redelegation: the coordinator agent attenuates the operator's delegation
 * and re-delegates it to a specialized revoker sub-agent. The child delegation
 * links to the parent via `parentDelegation`, inheriting all of its caveats and
 * adding a tighter call limit. Only the sub-agent can redeem the resulting chain.
 */
export async function createRedelegation(
  coordinatorAccount: any,
  parentSignedDelegation: any,
  subAgentAddress: Address,
  opts: { maxCalls?: number; salt?: Hex } = {}
) {
  const environment = getSmartAccountsEnvironment(getChainId());

  // Attenuation: child can redeem fewer times than the parent allows.
  const childCaveats = createCaveatBuilder(environment)
    .addCaveat("limitedCalls", { limit: opts.maxCalls ?? 5 })
    .build();

  const delegation = createDelegation({
    environment,
    to: subAgentAddress,
    from: coordinatorAccount.address,
    parentDelegation: parentSignedDelegation,
    caveats: childCaveats,
    // A unique salt yields a unique delegation hash, so single-use leaves
    // (limitedCalls(1)) created per relay don't collide with prior ones.
    ...(opts.salt ? { salt: opts.salt } : {}),
  });

  // Coordinator signs locally — no MetaMask popup (autonomous A2A handoff).
  const signature = await coordinatorAccount.signDelegation({ delegation });

  return { ...delegation, signature };
}

/**
 * x402 spend MANDATE (ERC-7710 signed authorization, NOT on-chain enforcement).
 *
 * The operator signs an operator→agent erc20TransferAmount delegation as a
 * revocable, off-chain spending mandate: a verifiable statement of "the agent
 * may spend up to N USDC on inference." The client-side cap (see App.tsx,
 * budget.spentUsd >= budget.capUsd) enforces against this mandate.
 *
 * IMPORTANT: this delegation is NOT redeemed and the ERC20TransferAmount
 * enforcer does NOT bound x402 spend on-chain. x402 settles via the "exact"
 * scheme — an ERC-3009 transferWithAuthorization signed by the agent EOA and
 * submitted by Venice's facilitator (see x402.ts). That direct USDC call never
 * flows through the DelegationManager, so no caveat enforcer can observe or
 * limit it. On-chain, spend is bounded only by the agent wallet's funded USDC
 * balance. Use this mandate as intent + UX guard, not as a trustless cap.
 */
export async function createBudgetDelegation(
  operatorAccount: any,
  agentAddress: Address,
  opts: { tokenAddress?: Address; maxAmount?: bigint } = {}
) {
  const environment = getSmartAccountsEnvironment(getChainId());

  const delegation = createDelegation({
    environment,
    to: agentAddress,
    from: operatorAccount.address,
    scope: {
      type: "erc20TransferAmount",
      tokenAddress: opts.tokenAddress ?? USDC_BASE,
      maxAmount: opts.maxAmount ?? 1_000_000n, // 1 USDC
    },
  });

  const signature = await operatorAccount.signDelegation({ delegation });

  return { ...delegation, signature };
}

// MAX_UINT256 — used to create an "unlimited" test approval from the smart
// account, mirroring the riskiest real-world approval pattern.
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Deploy a fresh, unverified Spender contract from the connected EOA (MetaMask
 * signs). Returns its address. Used to seed mock-malicious approvals that point
 * at an unknown, unverified, brand-new contract — what the risk heuristics flag.
 */
export async function deployMaliciousSpender(alchemyKey?: string): Promise<Address> {
  const { SPENDER_BYTECODE } = await import("./spenderBytecode");
  const { client: walletClient, address } = await getWalletClient();
  const publicClient = getPublicClient(alchemyKey);
  const hash = await walletClient.deployContract({
    account: address,
    chain: getChain(),
    abi: [],
    bytecode: SPENDER_BYTECODE,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error("Spender deployment produced no contract address");
  }
  return getAddress(receipt.contractAddress);
}

/**
 * Grant an unlimited (MAX) ERC-20 approval from the connected EOA to a spender
 * via MetaMask. Waits for the receipt; throws on revert. This is the EOA-owned
 * "mock-malicious" approval — directly revocable via revokeApprovalDirect.
 */
export async function createEoaMaxApproval(
  tokenAddress: Address,
  spender: Address,
  alchemyKey?: string
): Promise<Hex> {
  const { client: walletClient, address } = await getWalletClient();
  const publicClient = getPublicClient(alchemyKey);
  const hash = await walletClient.writeContract({
    account: address,
    chain: getChain(),
    address: tokenAddress,
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [spender, MAX_UINT256],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error("Approval transaction reverted");
  }
  return hash;
}

/**
 * Build a viem bundler client wired for Pimlico.
 *
 * Pimlico's `eth_estimateUserOperationGas` REQUIRES maxFeePerGas /
 * maxPriorityFeePerGas in the userOp. viem's default fee source is the public
 * client's `estimateFeesPerGas`, which returns nothing on bare public Sepolia
 * RPCs (e.g. rpc.sepolia.org) — so the estimate call goes out with undefined
 * fees and Pimlico rejects it ("Invalid input ... at params[0].userOp.maxFeePerGas").
 *
 * We instead source fees from Pimlico's own `pimlico_getUserOperationGasPrice`,
 * so estimation always has valid fee fields regardless of the RPC behind it.
 */
async function createPimlicoBundlerClient(bundlerUrl: string) {
  const { createBundlerClient } = await import("viem/account-abstraction");
  const publicClient = getPublicClient();

  const bundlerClient: any = createBundlerClient({
    client: publicClient,
    transport: http(bundlerUrl),
    userOperation: {
      estimateFeesPerGas: async () => {
        const { standard } = await bundlerClient.request({
          method: "pimlico_getUserOperationGasPrice",
        });
        return {
          maxFeePerGas: BigInt(standard.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(standard.maxPriorityFeePerGas),
        };
      },
    },
  });

  return bundlerClient;
}

/**
 * Create a (deliberately risky, unlimited) ERC-20 approval FROM the operator
 * smart account, by sending an approve(spender, MAX) UserOperation through the
 * bundler. This produces a smart-account-owned approval that the delegated agent
 * can later revoke autonomously via the ERC-7710 chain.
 *
 * The operator smart account must hold a little Sepolia ETH to pay for the
 * UserOp (the first one also deploys the account). approve() itself needs no
 * token balance — allowance is just a permission.
 */
export async function createSmartAccountApproval(
  operatorAccount: any,
  tokenAddress: Address,
  spender: Address,
  bundlerUrl: string
): Promise<Hex> {
  const bundlerClient = await createPimlicoBundlerClient(bundlerUrl);

  const data = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [spender, MAX_UINT256],
  });

  const userOpHash = await bundlerClient.sendUserOperation({
    account: operatorAccount,
    calls: [{ to: tokenAddress, data }],
  });

  const receipt = await bundlerClient.waitForUserOperationReceipt({
    hash: userOpHash,
  });
  if (!receipt.success) {
    throw new Error("Approval UserOperation reverted on-chain");
  }

  return (receipt.receipt?.transactionHash ?? userOpHash) as Hex;
}

// ---- Execution (Revocation) ----

export function buildRevocationCalldata(spender: Address): Hex {
  return encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [spender, 0n],
  });
}

/**
 * Ensure a smart account has on-chain code. Intermediate A2A delegators (the
 * Coordinator) must be DEPLOYED for the DelegationManager to validate their
 * redelegation signature via ERC-1271 — an undeployed delegator falls back to
 * EOA recovery and reverts with InvalidEOASignature() (0x3db6791c).
 *
 * A smart account can be deployed by anyone calling its factory, so the
 * connected wallet (which has gas) deploys it via the account's own factory
 * args. The deployed account is still owned by its original signer key. No-op if
 * already deployed.
 *
 * @returns "already" if code already exists, otherwise the deploy tx hash.
 */
export async function ensureSmartAccountDeployed(
  account: any,
  alchemyKey?: string
): Promise<"already" | Hex> {
  const publicClient = getPublicClient(alchemyKey);
  const code = await publicClient.getCode({ address: account.address });
  if (code && code !== "0x") return "already";

  const { factory, factoryData } = await account.getFactoryArgs();
  if (!factory || !factoryData) {
    throw new Error(`No factory args to deploy smart account ${account.address}`);
  }

  const { client: walletClient, address } = await getWalletClient();
  const hash = await walletClient.sendTransaction({
    account: address,
    chain: getChain(),
    to: factory as Address,
    data: factoryData as Hex,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * Redeem a delegation chain to revoke an approval.
 *
 * @param redeemerAccount  smart account that submits the UserOp — must be the
 *                         delegate of the leaf (first) delegation in the chain.
 * @param delegationChain  signed delegations ordered leaf → root, e.g.
 *                         [coordinator→revoker, operator→coordinator].
 *                         For a single (non-A2A) delegation pass [rootDelegation].
 */
export async function executeRevocation(
  redeemerAccount: any,
  delegationChain: any[],
  tokenAddress: Address,
  spender: Address,
  bundlerUrl: string
): Promise<Hex> {
  const bundlerClient = await createPimlicoBundlerClient(bundlerUrl);

  const environment = getSmartAccountsEnvironment(getChainId());

  const execution = createExecution({
    target: tokenAddress,
    value: 0n,
    callData: buildRevocationCalldata(spender),
  });

  const redeemData = DelegationManager.encode.redeemDelegations({
    delegations: [delegationChain],
    modes: [ExecutionMode.SingleDefault],
    executions: [[execution]],
  });

  const userOpHash = await bundlerClient.sendUserOperation({
    account: redeemerAccount,
    calls: [
      {
        to: environment.DelegationManager,
        data: redeemData,
      },
    ],
  });

  // Wait for the UserOperation to actually settle on-chain. A submitted hash is
  // NOT proof of revocation — only a mined receipt with success === true is.
  const receipt = await bundlerClient.waitForUserOperationReceipt({
    hash: userOpHash,
  });
  if (!receipt.success) {
    throw new Error("Revocation UserOperation reverted on-chain");
  }

  return (receipt.receipt?.transactionHash ?? userOpHash) as Hex;
}

const ERC20_ALLOWANCE_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
]);

/**
 * Directly revoke an ERC-20 approval the connected wallet (EOA) granted, by
 * sending approve(spender, 0) from that wallet via MetaMask. Only the approval
 * owner can zero its own allowance, so this is the reliable path for approvals
 * the user made themselves (as opposed to smart-account-owned approvals that a
 * delegation chain can revoke). Waits for the receipt and throws on revert.
 */
export async function revokeApprovalDirect(
  tokenAddress: Address,
  spender: Address,
  alchemyKey?: string
): Promise<Hex> {
  const { client: walletClient, address } = await getWalletClient();
  const publicClient = getPublicClient(alchemyKey);

  const hash = await walletClient.writeContract({
    account: address,
    chain: getChain(),
    address: tokenAddress,
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [spender, 0n],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error("Direct revocation transaction reverted");
  }
  return hash;
}

/**
 * Read the live on-chain ERC-20 allowance. Used as ground truth to confirm a
 * revocation actually zeroed the approval before reporting success.
 */
export async function readAllowance(
  tokenAddress: Address,
  owner: Address,
  spender: Address,
  alchemyKey?: string
): Promise<bigint> {
  const publicClient = getPublicClient(alchemyKey);
  return (await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ALLOWANCE_ABI,
    functionName: "allowance",
    args: [owner, spender],
  })) as bigint;
}

/**
 * Read how many redemptions remain on a delegation's LimitedCalls caveat,
 * straight from the enforcer's on-chain call counter (not a local guess).
 */
export async function getDelegationUsesLeft(
  delegation: any,
  limit: number,
  alchemyKey?: string
): Promise<number> {
  const environment = getSmartAccountsEnvironment(getChainId());
  const publicClient = getPublicClient(alchemyKey);

  const used = await LimitedCallsEnforcer.read.callCounts({
    client: publicClient as any,
    contractAddress: environment.caveatEnforcers.LimitedCallsEnforcer as Address,
    delegationManager: environment.DelegationManager as Address,
    delegationHash: hashDelegation(delegation),
  });

  return Math.max(0, limit - Number(used));
}

// ---- Utilities ----

export function shortenAddress(addr: string, chars = 4): string {
  return `${addr.slice(0, chars + 2)}...${addr.slice(-chars)}`;
}

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<any>;
      on: (event: string, handler: (...args: any[]) => void) => void;
      removeListener: (event: string, handler: (...args: any[]) => void) => void;
    };
  }
}

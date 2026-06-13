/**
 * oneshot.ts — 1Shot Permissionless Relayer (EIP-7710 gas abstraction).
 *
 * Relays the revocation as a gas-abstracted ERC-7710 transaction through the
 * 1Shot public relayer. The bundle carries TWO redemptions:
 *
 *   1. Fee — the agent's EOA (upgraded to a 7702 stateless delegator via an
 *      EIP-7702 authorization) signs a delegation to the relayer's redemption
 *      wallet scoped to USDC `transfer` only, paying the gas fee in USDC.
 *   2. Revocation — the coordinator redelegates the operator-rooted ERC-7710
 *      chain to the relayer's redemption wallet (single-use leaf), so the
 *      relayer redeems [coordinator→relayer, operator→coordinator] and
 *      `approve(spender, 0)` executes FROM the operator smart account — the
 *      actual owner of the approval being revoked.
 *
 * Flow (see 1Shot public-relayer skill):
 *   getCapabilities → build+sign bundle → estimate (lock quote) → send → status
 */

import { createDelegation } from "@metamask/smart-accounts-kit";
import { createRedelegation } from "./wallet";
import {
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  parseUnits,
  bytesToHex,
  getAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

const MAINNET_RELAYER = "https://relayer.1shotapi.com/relayers";
const TESTNET_RELAYER = "https://relayer.1shotapi.dev/relayers";

export function relayerUrlForChain(chainId: number): string {
  return chainId === 11155111 || chainId === 84532
    ? TESTNET_RELAYER
    : MAINNET_RELAYER;
}

const APPROVE_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

// ---- JSON-RPC ----

type JsonRpc<T> =
  | { jsonrpc: "2.0"; id: number | string; result: T }
  | { jsonrpc: "2.0"; id: number | string; error: { code: number; message: string; data?: unknown } };

async function rpc<T>(url: string, method: string, params: unknown, id = 1): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const json = (await res.json()) as JsonRpc<T>;
  if (!res.ok) throw new Error(`Relayer HTTP ${res.status}: ${JSON.stringify(json)}`);
  if ("error" in json) {
    throw new Error(`[${json.error.code}] ${json.error.message} ${JSON.stringify(json.error.data ?? "")}`);
  }
  return json.result;
}

/** Convert delegation bigints / Uint8Arrays into JSON-safe shapes. */
function toRelayerJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return `0x${value.toString(16)}`;
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (Array.isArray(value)) return value.map(toRelayerJson);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toRelayerJson(v);
    return out;
  }
  return value;
}

// ---- Types ----

interface ChainCapabilities {
  feeCollector: Address;
  targetAddress: Address;
  tokens: { address: Address; symbol?: string; decimals: number | string }[];
}

interface Estimate7710Result {
  success: boolean;
  requiredPaymentAmount?: string;
  gasUsed?: Record<string, string>;
  context?: string;
  error?: string;
}

interface RelayerStatus {
  status: 100 | 110 | 200 | 400 | 500;
  hash?: Hex;
  receipt?: object;
  message?: string;
  data?: unknown;
  memo?: string;
}

export interface RelayResult {
  taskId: string;
  txHash: Hex | null;
  feeUsdc: string;
  status: "confirmed" | "reverted" | "rejected" | "timeout";
}

// ---- High-level API ----

export async function getCapabilities(
  chainId: number,
  url = relayerUrlForChain(chainId)
): Promise<ChainCapabilities> {
  const caps = await rpc<Record<string, ChainCapabilities>>(
    url,
    "relayer_getCapabilities",
    [String(chainId)]
  );
  const chainCaps = caps[String(chainId)];
  if (!chainCaps) throw new Error(`1Shot relayer does not support chain ${chainId}`);
  return chainCaps;
}

interface RevokeViaRelayerParams {
  chainId: number;
  // 7702 stateless-delegator smart account for the agent (pays the USDC fee).
  smartAccount: any;
  // Underlying EOA account (signs the EIP-7702 authorization).
  eoaAccount: any;
  publicClient: PublicClient;
  // EIP7702StatelessDeleGatorImpl address from the SDK environment.
  statelessImpl: Address;
  // Coordinator smart account — delegate of the operator's root delegation.
  // Signs the single-use redelegation to the relayer's redemption wallet.
  coordinatorAccount: any;
  // Signed operator → coordinator root delegation. Rooting the redeemed chain
  // here is what makes approve(spender, 0) execute FROM the operator smart
  // account (the approval owner) instead of the agent's own account.
  rootDelegation: any;
  tokenAddress: Address;
  spender: Address;
  // Whether to include an EIP-7702 authorizationList (upgrade on first use).
  upgrade?: boolean;
  destinationUrl?: string;
  onLog?: (msg: string) => void;
}

/** Inputs for the pure bundle builder (exported for unit tests). */
export interface RelayerBundleInput {
  chainId: number;
  authorizationList?: unknown[];
  /** Signed agent → relayer delegation scoped to USDC transfer (fee payment). */
  signedFeeDelegation: unknown;
  /**
   * Signed revocation delegation chain ordered leaf → root, e.g.
   * [coordinator→relayerTarget, operator→coordinator]. The leaf delegate must
   * be the relayer's redemption wallet; the root delegator is the account the
   * revocation executes from.
   */
  signedRevocationChain: unknown[];
  usdcAddress: Address;
  feeCollector: Address;
  feeAmount: bigint;
  tokenAddress: Address;
  spender: Address;
}

/**
 * Build the relayer_estimate/send 7710 bundle: fee redemption first (paid by
 * the agent), then the operator-rooted revocation redemption. Pure — all
 * signing happens in the caller.
 */
export function buildRelayerBundle(input: RelayerBundleInput) {
  const feeData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [input.feeCollector, input.feeAmount],
  });
  const revokeData = encodeFunctionData({
    abi: APPROVE_ABI,
    functionName: "approve",
    args: [input.spender, 0n],
  });
  return {
    chainId: String(input.chainId),
    ...(input.authorizationList ? { authorizationList: input.authorizationList } : {}),
    transactions: [
      {
        permissionContext: [toRelayerJson(input.signedFeeDelegation)],
        executions: [{ target: input.usdcAddress, value: "0", data: feeData }],
      },
      {
        permissionContext: input.signedRevocationChain.map(toRelayerJson),
        executions: [{ target: input.tokenAddress, value: "0", data: revokeData }],
      },
    ],
  };
}

function randomSalt(): Hex {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32))) as Hex;
}

/**
 * Revoke an ERC-20 approval through the 1Shot relayer, paying gas in USDC.
 */
export async function revokeViaRelayer(p: RevokeViaRelayerParams): Promise<RelayResult> {
  const url = relayerUrlForChain(p.chainId);
  const log = p.onLog ?? (() => {});

  // 1) Capabilities — targetAddress (delegate `to`), feeCollector, accepted USDC.
  const caps = await getCapabilities(p.chainId, url);
  const usdc = caps.tokens.find((t) => t.symbol === "USDC") ?? caps.tokens[0];
  if (!usdc) throw new Error("Relayer lists no accepted payment tokens");
  const usdcDecimals = Number(usdc.decimals);
  log(`1Shot: target ${short(caps.targetAddress)} · fee in ${usdc.symbol ?? "token"}`);

  // 2) EIP-7702 authorization (upgrade the agent EOA to a stateless delegator).
  let authorizationList: unknown[] | undefined;
  if (p.upgrade) {
    const nonce = await p.publicClient.getTransactionCount({
      address: p.eoaAccount.address,
      blockTag: "pending",
    });
    const auth = await p.eoaAccount.signAuthorization({
      chainId: p.chainId,
      contractAddress: getAddress(p.statelessImpl),
      nonce,
    });
    authorizationList = [
      {
        address: auth.address ?? auth.contractAddress,
        chainId: auth.chainId,
        nonce: auth.nonce,
        r: auth.r,
        s: auth.s,
        yParity: auth.yParity ?? 0,
      },
    ];
    log("1Shot: EIP-7702 authorization signed (account upgrade in-flight)");
  }

  // 3) Build + sign the bundle. Two redemptions:
  //    - fee: agent → relayer delegation, USDC transfer only (agent pays gas);
  //    - revoke: operator-rooted chain redelegated to the relayer, so the
  //      approve(spender, 0) executes from the operator smart account.
  const buildBundle = async (feeAmount: bigint) => {
    const feeDelegation = createDelegation({
      to: caps.targetAddress,
      from: p.smartAccount.address,
      environment: p.smartAccount.environment,
      salt: randomSalt(),
      scope: {
        type: "functionCall",
        targets: [usdc.address],
        selectors: ["transfer(address,uint256)"],
      },
    });
    const feeSignature = await p.smartAccount.signDelegation({
      delegation: feeDelegation,
    });

    // Single-use leaf: coordinator attenuates the operator's delegation down to
    // ONE redemption for the relayer's redemption wallet. Inherits the root's
    // functionCall(approve)/targets/expiry caveats; signed locally (A2A).
    const relayerLeaf = await createRedelegation(
      p.coordinatorAccount,
      p.rootDelegation,
      caps.targetAddress,
      { maxCalls: 1, salt: randomSalt() }
    );

    return buildRelayerBundle({
      chainId: p.chainId,
      authorizationList,
      signedFeeDelegation: { ...feeDelegation, signature: feeSignature },
      signedRevocationChain: [relayerLeaf, p.rootDelegation],
      usdcAddress: usdc.address,
      feeCollector: caps.feeCollector,
      feeAmount,
      tokenAddress: p.tokenAddress,
      spender: p.spender,
    });
  };

  // 4) Estimate with a mock fee ≥ minFee, adjust to requiredPaymentAmount, re-sign.
  const mockFee = parseUnits("0.01", usdcDecimals);
  let params = await buildBundle(mockFee);
  let estimate = await rpc<Estimate7710Result>(url, "relayer_estimate7710Transaction", params);
  if (!estimate.success) throw new Error(estimate.error ?? "estimate failed");

  const requiredFee = BigInt(estimate.requiredPaymentAmount ?? mockFee.toString());
  if (requiredFee !== mockFee) {
    params = await buildBundle(requiredFee);
    estimate = await rpc<Estimate7710Result>(url, "relayer_estimate7710Transaction", params);
    if (!estimate.success) throw new Error(estimate.error ?? "re-estimate failed");
  }
  const feeUsdc = formatUnits(BigInt(estimate.requiredPaymentAmount ?? requiredFee.toString()), usdcDecimals);
  log(`1Shot: quote locked — gas fee ${feeUsdc} ${usdc.symbol ?? ""}`);

  // 5) Submit with the price-lock context (and webhook URL if provided).
  const taskId = await rpc<string>(url, "relayer_send7710Transaction", {
    ...params,
    context: estimate.context,
    ...(p.destinationUrl ? { destinationUrl: p.destinationUrl } : {}),
    memo: "scam-slayer-revoke",
  });
  log(`1Shot: submitted task ${taskId}`);

  // 6) Track status (webhook preferred; we poll as the in-app source of truth).
  const final = await pollUntilTerminal(url, taskId, log);
  return { taskId, txHash: final.hash ?? null, feeUsdc, status: terminalLabel(final.status) };
}

async function pollUntilTerminal(
  url: string,
  taskId: string,
  log: (m: string) => void,
  intervalMs = 3000,
  timeoutMs = 120000
): Promise<RelayerStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = -1;
  while (Date.now() < deadline) {
    const s = await rpc<RelayerStatus>(url, "relayer_getStatus", { id: taskId, logs: false });
    if (s.status !== lastStatus) {
      lastStatus = s.status;
      if (s.status === 110 && s.hash) log(`1Shot: on-chain tx ${short(s.hash)}`);
    }
    if (s.status === 200 || s.status === 400 || s.status === 500) return s;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { status: 400, message: "timeout" };
}

function terminalLabel(s: number): RelayResult["status"] {
  if (s === 200) return "confirmed";
  if (s === 500) return "reverted";
  return s === 400 ? "rejected" : "timeout";
}

function formatUnits(atoms: bigint, decimals: number): string {
  const s = atoms.toString().padStart(decimals + 1, "0");
  const i = s.slice(0, s.length - decimals);
  const f = s.slice(s.length - decimals).replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}

function short(a: string): string {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

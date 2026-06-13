/**
 * scanner.ts — Token approval scanner
 *
 * Discovers active ERC-20 approvals for a wallet from on-chain Approval events,
 * confirms each against the LIVE `allowance(owner, spender)` (so revoked/zero
 * approvals are dropped), and enriches with real contract age + verification
 * status from Etherscan. Risk is scored from these real signals — nothing is
 * fabricated. Falls back to labelled mock data only when live reads fail.
 */

import { parseAbi, parseAbiItem, getAddress } from "viem";
import type { Address, PublicClient } from "viem";
import type { TokenApproval } from "./types";
import { getPublicClient } from "./wallet";
import { getChainId, getActiveChainConfig, ETHERSCAN_V2_API } from "./chains";
import { fetchTokenPricesUsd, computeExposure } from "./prices";
import { getProxyUrl } from "./proxy";

const MAX_UINT256 = (1n << 256n) - 1n;
// Treat anything >= 2^255 as an effectively-unlimited approval.
const UNLIMITED_THRESHOLD = 1n << 255n;

// How far back to scan for Approval events. With an Alchemy key we can cover a
// deep window (Sepolia ~12s blocks → ~weeks); on the rate-limited public RPC we
// stay shallow so the scan still returns quickly.
const ALCHEMY_LOOKBACK_BLOCKS = 500_000n;
const PUBLIC_LOOKBACK_BLOCKS = 10_000n;
// eth_getLogs chunk size. Alchemy *paid* serves wide ranges as long as the
// result set is small; the public RPC and Alchemy *free* tier cap the range
// hard (free tier = 10 blocks), so the chunker shrinks adaptively (see below).
const ALCHEMY_CHUNK_BLOCKS = 10_000n;
const PUBLIC_CHUNK_BLOCKS = 800n;
// Floor for adaptive chunk shrinking. A 10-block range satisfies Alchemy's free
// tier; we never shrink below this (a 1-block range always works as a fallback).
const MIN_CHUNK_BLOCKS = 10n;
// Hard cap on getLogs requests per fetchApprovals call. On a range-capped tier
// (free Alchemy = 10 blocks) this bounds both work AND request volume: a deep
// brute-force scan would fire hundreds of tiny requests and trip rate limits.
// 12 × 10 blocks ≈ the most recent ~120 blocks (~24 min of Sepolia) — enough to
// catch approvals made during a session without hammering the RPC. Paid tiers
// serve the whole range in the single fast-path request and never get here.
const MAX_GETLOGS_REQUESTS = 12;
// Global throttle: minimum gap between getLogs request STARTS, shared across all
// concurrent callers (the scan fans out to multiple wallets at once). Keeps us
// under free-tier burst limits (~4 req/s) instead of flooding and getting 429s.
const MIN_REQUEST_GAP_MS = 250;
const MAX_RATE_LIMIT_RETRIES = 4;
const RETRY_BASE_MS = 400;
const MAX_PAIRS_TO_QUERY = 50;

const APPROVAL_EVENT = parseAbiItem(
  "event Approval(address indexed owner, address indexed spender, uint256 value)"
);

const ERC20_READ_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
]);

// Known safe routers (Sepolia + mainnet)
const KNOWN_SAFE: Record<string, string> = {
  "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD": "Uniswap Universal Router",
  "0xE592427A0AEce92De3Edee1F18E0157C05861564": "Uniswap V3 Router",
  "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F": "SushiSwap Router",
  "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45": "Uniswap V3 Router 2",
};

interface SpenderInfo {
  // null = unknown (could not determine — NOT fabricated)
  contractAge: number | null;
  verified: boolean | null;
}

// Flatten a (possibly wrapped) viem error into searchable text. viem nests the
// useful bits across .message/.details/.metaMessages and a .cause chain, so we
// walk all of them — the block-range hint lives in .details, not .message.
export function collectErrorText(error: unknown): string {
  let text = "";
  let cur: any = error;
  for (let depth = 0; cur && depth < 6; depth++) {
    if (typeof cur === "string") {
      text += " " + cur;
    } else {
      if (cur.message) text += " " + cur.message;
      if (cur.details) text += " " + cur.details;
      if (cur.shortMessage) text += " " + cur.shortMessage;
      if (Array.isArray(cur.metaMessages)) text += " " + cur.metaMessages.join(" ");
    }
    cur = cur.cause;
  }
  return text;
}

export function isRateLimitError(error: unknown): boolean {
  const msg = collectErrorText(error).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests")
  );
}

// A provider rejecting a getLogs range as too wide (block-range cap or result
// size cap). Distinct from rate limiting — the cure is a smaller range, not a
// retry.
export function isRangeLimitError(error: unknown): boolean {
  const msg = collectErrorText(error).toLowerCase();
  return (
    msg.includes("block range") ||
    msg.includes("response size") ||
    msg.includes("query returned more than") ||
    msg.includes("logs matched") ||
    (msg.includes("up to") && msg.includes("range"))
  );
}

// Pull the provider's allowed block span out of a range-limit error so we can
// resize chunks exactly instead of blindly halving. Handles both Alchemy's
// "up to a 10 block range" phrasing and a suggested "[0x.., 0x..]" range.
export function parseAllowedRange(error: unknown): bigint | null {
  const msg = collectErrorText(error);
  const upTo = msg.match(/up to (?:a )?(\d+)\s*block/i);
  if (upTo) {
    const n = BigInt(upTo[1]);
    if (n > 0n) return n;
  }
  const suggested = msg.match(/\[\s*(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\s*\]/);
  if (suggested) {
    const lo = BigInt(suggested[1]);
    const hi = BigInt(suggested[2]);
    if (hi >= lo) return hi - lo + 1n;
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Global getLogs rate gate. The scan fans out to several wallets concurrently,
// so a per-call limiter isn't enough — we serialize every getLogs through one
// promise chain and enforce MIN_REQUEST_GAP_MS between request starts. This is
// what stops the free-tier 429 storm when many small chunked requests queue up.
let getLogsChain: Promise<void> = Promise.resolve();
let lastGetLogsStart = 0;

async function acquireGetLogsSlot(): Promise<void> {
  const prev = getLogsChain;
  let release!: () => void;
  getLogsChain = new Promise<void>((resolve) => (release = resolve));
  await prev;
  const gap = Date.now() - lastGetLogsStart;
  if (gap < MIN_REQUEST_GAP_MS) await sleep(MIN_REQUEST_GAP_MS - gap);
  lastGetLogsStart = Date.now();
  // Hand back the next-caller release; the current caller invokes it once its
  // request has started (we release immediately so the gap is start-to-start).
  release();
}

async function getLogsWithRetry(
  client: PublicClient,
  params: {
    event: typeof APPROVAL_EVENT;
    args: { owner: Address };
    fromBlock: bigint;
    toBlock: bigint;
  }
) {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    await acquireGetLogsSlot();
    try {
      return await client.getLogs(params);
    } catch (error) {
      const isRetriable = isRateLimitError(error);
      if (!isRetriable || attempt === MAX_RATE_LIMIT_RETRIES) {
        throw error;
      }
      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }
  return [];
}

// Once a provider rejects a wide getLogs range (e.g. Alchemy's free tier caps
// it at 10 blocks), remember the allowed span keyed by RPC URL. The app
// auto-rescans every ~30s, so without this every scan would re-fire the doomed
// wide fast-path request and surface the same "block range" error repeatedly.
// With the cap memoized, subsequent scans skip straight to correctly-sized
// chunks. Paid tiers never set this (their wide request succeeds).
const rangeCapByUrl = new Map<string, bigint>();

function clientUrl(client: PublicClient): string {
  const t: any = (client as any).transport;
  return t?.url ?? t?.transports?.[0]?.value?.url ?? "default";
}

async function fetchApprovalLogs(
  client: PublicClient,
  walletAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize: bigint
): Promise<any[]> {
  const start = fromBlock < 0n ? 0n : fromBlock;
  const url = clientUrl(client);

  // Apply a previously-discovered range cap for this provider before doing any
  // work, so we never re-attempt the doomed wide request on a capped RPC.
  const knownCap = rangeCapByUrl.get(url);
  if (knownCap && knownCap < chunkSize) chunkSize = knownCap;

  // Fast path: try the whole range in one request. Paid Alchemy serves it when
  // the result set is small. Skipped entirely once we know this RPC is capped.
  // If the range is rejected, remember the provider's stated limit (e.g. free
  // tier's 10 blocks) and chunk-scan.
  if (!knownCap) {
    try {
      return await getLogsWithRetry(client, {
        event: APPROVAL_EVENT,
        args: { owner: walletAddress },
        fromBlock: start,
        toBlock,
      });
    } catch (err) {
      if (isRateLimitError(err)) throw err; // let the caller surface rate limits
      if (!isRangeLimitError(err)) throw err; // genuine RPC failure — don't mask it
      const allowed = parseAllowedRange(err);
      if (allowed) {
        rangeCapByUrl.set(url, allowed);
        if (allowed < chunkSize) chunkSize = allowed;
      }
    }
  }

  const logs: any[] = [];
  let requests = 0;
  let chunkTo = toBlock;
  while (chunkTo >= start && requests < MAX_GETLOGS_REQUESTS) {
    const chunkFrom =
      chunkTo >= chunkSize - 1n + start ? chunkTo - (chunkSize - 1n) : start;

    let chunk: any[];
    try {
      chunk = await getLogsWithRetry(client, {
        event: APPROVAL_EVENT,
        args: { owner: walletAddress },
        fromBlock: chunkFrom,
        toBlock: chunkTo,
      });
    } catch (err) {
      requests += 1;
      if (isRateLimitError(err)) throw err;
      if (!isRangeLimitError(err)) throw err;
      // Still too wide for this provider — shrink and retry the same chunkTo.
      const allowed = parseAllowedRange(err);
      if (allowed) rangeCapByUrl.set(url, allowed);
      const next =
        allowed && allowed < chunkSize ? allowed : chunkSize / 2n;
      const shrunk = next < MIN_CHUNK_BLOCKS ? MIN_CHUNK_BLOCKS : next;
      if (shrunk >= chunkSize) break; // can't shrink further — stop gracefully
      chunkSize = shrunk;
      continue;
    }

    logs.push(...chunk);
    requests += 1;
    if (chunkFrom === start) break;
    chunkTo = chunkFrom - 1n;
  }

  return logs;
}

/**
 * Fetch active token approvals for a wallet from real on-chain data.
 */
export async function fetchApprovals(
  walletAddress: Address,
  alchemyApiKey: string,
  etherscanApiKey?: string,
  ownerType: "eoa" | "smart-account" = "eoa"
): Promise<TokenApproval[]> {
  try {
    const client = getPublicClient(alchemyApiKey) as PublicClient;
    // Deep one-shot scan when the provider serves wide ranges — either a
    // wide-range chain RPC (Infura on Sepolia) or a (paid) Alchemy key. Otherwise
    // stay shallow; the chunker/memo adapts down for any provider that rejects.
    const wide = !!alchemyApiKey || !!getActiveChainConfig().wideRange;
    const lookback = wide ? ALCHEMY_LOOKBACK_BLOCKS : PUBLIC_LOOKBACK_BLOCKS;
    const chunkSize = wide ? ALCHEMY_CHUNK_BLOCKS : PUBLIC_CHUNK_BLOCKS;

    const latest = await client.getBlockNumber();
    const fromBlock = latest > lookback ? latest - lookback : 0n;

    const logs = await fetchApprovalLogs(
      client,
      walletAddress,
      fromBlock,
      latest,
      chunkSize
    );

    // Latest Approval per (token, spender) pair.
    const pairs = new Map<string, { token: Address; spender: Address }>();
    for (const log of logs) {
      const token = getAddress(log.address);
      const spender = log.args.spender as Address;
      if (!spender) continue;
      pairs.set(`${token}-${spender}`, { token, spender });
    }
    if (pairs.size === 0) return [];

    const entries = [...pairs.values()].slice(0, MAX_PAIRS_TO_QUERY);

    // Read LIVE allowance + symbol + decimals + balance for each pair in ONE
    // multicall (drops revoked approvals; balance/decimals feed the exposure calc).
    const calls = entries.flatMap(({ token, spender }) => [
      {
        address: token,
        abi: ERC20_READ_ABI,
        functionName: "allowance" as const,
        args: [walletAddress, spender] as const,
      },
      {
        address: token,
        abi: ERC20_READ_ABI,
        functionName: "symbol" as const,
      },
      {
        address: token,
        abi: ERC20_READ_ABI,
        functionName: "decimals" as const,
      },
      {
        address: token,
        abi: ERC20_READ_ABI,
        functionName: "balanceOf" as const,
        args: [walletAddress] as const,
      },
    ]);

    const results = await client.multicall({ contracts: calls as any });

    interface LivePair {
      token: Address;
      spender: Address;
      symbol: string;
      allowance: bigint;
      decimals: number | null;
      balance: bigint | null;
    }
    const live: LivePair[] = [];
    for (let i = 0; i < entries.length; i++) {
      const { token, spender } = entries[i];
      const [allowanceRes, symbolRes, decimalsRes, balanceRes] = [
        results[i * 4],
        results[i * 4 + 1],
        results[i * 4 + 2],
        results[i * 4 + 3],
      ];

      const allowance =
        allowanceRes?.status === "success"
          ? (allowanceRes.result as bigint)
          : 0n;
      if (allowance === 0n) continue; // already revoked / never approved

      live.push({
        token,
        spender,
        symbol:
          symbolRes?.status === "success" ? (symbolRes.result as string) : "TOKEN",
        decimals:
          decimalsRes?.status === "success" ? Number(decimalsRes.result) : null,
        balance:
          balanceRes?.status === "success" ? (balanceRes.result as bigint) : null,
        allowance,
      });
    }

    // One batched price lookup for all distinct tokens (never throws — tokens
    // without a price simply get exposure = unknown).
    const prices = await fetchTokenPricesUsd(
      getChainId(),
      live.map(({ token, symbol }) => ({ address: token, symbol }))
    );

    const approvals: TokenApproval[] = [];
    for (const p of live) {
      const info = await getSpenderInfo(p.spender, etherscanApiKey);
      approvals.push(
        buildApproval(p.token, p.spender, p.symbol, p.allowance, info, walletAddress, ownerType, {
          balance: p.balance,
          decimals: p.decimals,
          priceUsd: prices.get(p.token.toLowerCase()) ?? null,
        })
      );
    }

    // Biggest dollar-at-risk first (unknown exposure last), risk as tiebreaker.
    return approvals.sort(
      (a, b) =>
        (b.exposureUsd ?? -1) - (a.exposureUsd ?? -1) || b.riskScore - a.riskScore
    );
  } catch (err) {
    console.warn("Live approval scan failed:", err);
    return [];
  }
}

/**
 * Real contract age (days since deployment) + source-verification status via
 * the Etherscan v2 API. Returns nulls (unknown) when no key is provided or the
 * lookup fails — these stay honest rather than inventing values.
 */
async function getSpenderInfo(
  spender: Address,
  etherscanApiKey?: string
): Promise<SpenderInfo> {
  // In proxy mode the worker injects the Etherscan key; otherwise a client key
  // is required (no key → age/verification stay honestly unknown).
  const proxy = getProxyUrl();
  if (!proxy && !etherscanApiKey) return { contractAge: null, verified: null };

  // Etherscan v2: one host + the active chain id covers mainnet/Base/Linea/Sepolia.
  const base = proxy
    ? `${proxy}/etherscan?chainid=${getChainId()}`
    : `${ETHERSCAN_V2_API}?chainid=${getChainId()}&apikey=${etherscanApiKey}`;
  const out: SpenderInfo = { contractAge: null, verified: null };

  try {
    const srcRes = await fetch(
      `${base}&module=contract&action=getsourcecode&address=${spender}`
    );
    const srcData = await srcRes.json();
    const entry = srcData?.result?.[0];
    if (entry) {
      const source = (entry.SourceCode || "").trim();
      out.verified = source.length > 0;
    }
  } catch {
    /* leave verified unknown */
  }

  try {
    const createRes = await fetch(
      `${base}&module=contract&action=getcontractcreation&contractaddresses=${spender}`
    );
    const createData = await createRes.json();
    const entry = createData?.result?.[0];
    const ts = entry?.timestamp ? Number(entry.timestamp) : null;
    if (ts) {
      out.contractAge = Math.max(0, Math.floor((Date.now() / 1000 - ts) / 86400));
    }
  } catch {
    /* leave age unknown */
  }

  return out;
}

/**
 * Score an approval's risk level (0-100) from real signals only, and return the
 * human-readable factors that drove that score. Unknown signals (null) are
 * treated cautiously but never fabricated.
 */
export function scoreRisk(
  spender: Address,
  isMaxApproval: boolean,
  contractAge: number | null,
  verified: boolean | null,
  spenderLabel: string | null
): { score: number; factors: string[] } {
  if (spenderLabel || KNOWN_SAFE[spender]) {
    // Known-safe router: low baseline even with max approval.
    const label = spenderLabel || KNOWN_SAFE[spender];
    return {
      score: isMaxApproval ? 15 : 5,
      factors: [
        `Known-safe spender (${label})`,
        isMaxApproval ? "Unlimited approval, but to a trusted router" : "Bounded approval",
      ],
    };
  }

  let score = 0;
  const factors: string[] = [];
  if (isMaxApproval) {
    score += 30;
    factors.push("Unlimited (MAX) token approval");
  }
  if (!spenderLabel) {
    score += 20;
    factors.push("Spender is unknown / unlabelled");
  }
  if (verified === false) {
    score += 20;
    factors.push("Contract source is NOT verified");
  } else if (verified === null) {
    score += 10;
    factors.push("Verification status unknown");
  }
  if (contractAge !== null) {
    if (contractAge < 7) {
      score += 25;
      factors.push(`Contract is brand new (${contractAge}d old)`);
    } else if (contractAge < 30) {
      score += 10;
      factors.push(`Contract is recent (${contractAge}d old)`);
    } else {
      factors.push(`Contract age ${contractAge}d`);
    }
  } else {
    score += 10;
    factors.push("Contract age unknown");
  }

  if (!factors.length) factors.push("No elevated-risk signals detected");
  return { score: Math.max(0, Math.min(100, score)), factors };
}

export function buildApproval(
  tokenAddress: Address,
  spender: Address,
  tokenSymbol: string,
  allowance: bigint,
  info: SpenderInfo,
  owner: Address,
  ownerType: "eoa" | "smart-account",
  // Inputs for the dollar-at-risk calc. Optional: callers without balance/price
  // data (tests, legacy paths) get exposure = unknown, never fabricated.
  exposure?: {
    balance: bigint | null;
    decimals: number | null;
    priceUsd: number | null;
  }
): TokenApproval {
  const isMax = allowance >= UNLIMITED_THRESHOLD;
  const label = KNOWN_SAFE[spender] || null;
  const verified = label ? true : info.verified;
  const contractAge = label ? 9999 : info.contractAge;

  const { score: riskScore, factors: riskFactors } = scoreRisk(
    spender,
    isMax,
    contractAge,
    verified,
    label
  );

  const priceUsd = exposure?.priceUsd ?? null;
  const { exposureTokens, exposureUsd } = computeExposure(
    allowance,
    exposure?.balance ?? null,
    exposure?.decimals ?? null,
    priceUsd
  );

  return {
    id: `${owner}-${tokenAddress}-${spender}`,
    token: tokenSymbol,
    tokenAddress,
    spender,
    spenderLabel: label,
    amount: isMax ? "MAX (unlimited)" : allowance.toString(),
    isMaxApproval: isMax,
    riskScore,
    riskFactors,
    contractAge: contractAge ?? -1,
    verified: verified ?? false,
    exposureUsd,
    exposureTokens,
    priceUsd,
    status: riskScore > 75 ? "threat" : riskScore > 40 ? "analyzing" : "safe",
    owner,
    ownerType,
  };
}

/**
 * Mock approvals for demo mode (no wallet / live read failed).
 */
export function getMockApprovals(): TokenApproval[] {
  const mockOwner = "0x7f3a9Bc1D2E4F5A6B7C8D9E0F1A2B3C4D5E6F7A8" as Address;
  const mocks = [
    {
      id: "mock-1",
      token: "USDC",
      tokenAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address,
      spender: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD" as Address,
      spenderLabel: "Uniswap Universal Router",
      amount: "MAX (unlimited)",
      isMaxApproval: true,
      riskScore: 15,
      riskFactors: [
        "Known-safe spender (Uniswap Universal Router)",
        "Unlimited approval, but to a trusted router",
      ],
      contractAge: 890,
      verified: true,
      exposureUsd: 250,
      exposureTokens: 250,
      priceUsd: 1,
      status: "safe",
    },
    {
      id: "mock-2",
      token: "WETH",
      tokenAddress: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9" as Address,
      spender: "0xd3aB4c8e91c28fA2b00c9D7E1f3a9b6c0d291c2" as Address,
      spenderLabel: null,
      amount: "MAX (unlimited)",
      isMaxApproval: true,
      riskScore: 87,
      riskFactors: [
        "Unlimited (MAX) token approval",
        "Spender is unknown / unlabelled",
        "Contract source is NOT verified",
        "Contract is brand new (3d old)",
      ],
      contractAge: 3,
      verified: false,
      exposureUsd: 4210,
      exposureTokens: 1.85,
      priceUsd: 2276,
      status: "threat",
    },
    {
      id: "mock-3",
      token: "DAI",
      tokenAddress: "0x68194a729C2450ad26072b3D33ADaCbcef39D574" as Address,
      spender: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F" as Address,
      spenderLabel: "SushiSwap Router",
      amount: "5,000",
      isMaxApproval: false,
      riskScore: 5,
      riskFactors: ["Known-safe spender (SushiSwap Router)", "Bounded approval"],
      contractAge: 1200,
      verified: true,
      exposureUsd: 5000,
      exposureTokens: 5000,
      priceUsd: 1,
      status: "safe",
    },
    {
      id: "mock-4",
      token: "LINK",
      tokenAddress: "0x779877A7B0D9E8603169DdbD7836e478b4624789" as Address,
      spender: "0xaF3e9c81B0d74F2A536c9E8D1b6a0F5e2Dcc0100" as Address,
      spenderLabel: null,
      amount: "MAX (unlimited)",
      isMaxApproval: true,
      riskScore: 94,
      riskFactors: [
        "Unlimited (MAX) token approval",
        "Spender is unknown / unlabelled",
        "Contract source is NOT verified",
        "Contract is brand new (1d old)",
      ],
      contractAge: 1,
      verified: false,
      exposureUsd: 1820,
      exposureTokens: 130,
      priceUsd: 14,
      status: "analyzing",
    },
  ];
  return mocks.map((m) => ({
    ...m,
    owner: mockOwner,
    ownerType: "eoa" as const,
  })) as TokenApproval[];
}

export { KNOWN_SAFE };

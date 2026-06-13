/**
 * scanner.test.ts — pins down the heuristic risk scoring that drives the
 * agent's autonomous revocations (Autonomous Kill Mode sweeps everything at or
 * above the threshold), plus the RPC error classifiers / range parser that the
 * adaptive getLogs chunker relies on against capped free-tier providers.
 */
import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import {
  scoreRisk,
  buildApproval,
  collectErrorText,
  isRateLimitError,
  isRangeLimitError,
  parseAllowedRange,
  KNOWN_SAFE,
} from "./scanner";

const UNISWAP_ROUTER = "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD" as Address;
const UNKNOWN_SPENDER = "0x00000000000000000000000000000000DeaDBeef" as Address;
const TOKEN = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
const OWNER = "0x7f3a9Bc1D2E4F5A6B7C8D9E0F1A2B3C4D5E6F7A8" as Address;

describe("scoreRisk", () => {
  it("scores a known-safe router low even with a max approval", () => {
    const { score, factors } = scoreRisk(UNISWAP_ROUTER, true, 890, true, KNOWN_SAFE[UNISWAP_ROUTER]);
    expect(score).toBe(15);
    expect(factors[0]).toContain("Known-safe spender");
  });

  it("scores a known-safe router with a bounded approval even lower", () => {
    expect(scoreRisk(UNISWAP_ROUTER, false, 890, true, KNOWN_SAFE[UNISWAP_ROUTER]).score).toBe(5);
  });

  it("scores the worst case (max, unknown, unverified, brand-new) at 95", () => {
    const { score, factors } = scoreRisk(UNKNOWN_SPENDER, true, 3, false, null);
    expect(score).toBe(95); // 30 max + 20 unknown + 20 unverified + 25 brand-new
    expect(factors).toEqual([
      "Unlimited (MAX) token approval",
      "Spender is unknown / unlabelled",
      "Contract source is NOT verified",
      "Contract is brand new (3d old)",
    ]);
  });

  it("treats unknown verification/age more cautiously than known-good, less than known-bad", () => {
    const knownGood = scoreRisk(UNKNOWN_SPENDER, false, 365, true, null).score; // 20
    const unknown = scoreRisk(UNKNOWN_SPENDER, false, null, null, null).score; // 20+10+10
    const knownBad = scoreRisk(UNKNOWN_SPENDER, false, 3, false, null).score; // 20+20+25
    expect(knownGood).toBe(20);
    expect(unknown).toBe(40);
    expect(knownBad).toBe(65);
  });

  it("adds a reduced penalty for recent (7-30d) contracts", () => {
    const recent = scoreRisk(UNKNOWN_SPENDER, false, 15, true, null);
    expect(recent.score).toBe(30); // 20 unknown spender + 10 recent
    expect(recent.factors).toContain("Contract is recent (15d old)");
  });

  it("always returns at least one explanatory factor", () => {
    const { factors } = scoreRisk(UNKNOWN_SPENDER, false, 365, true, null);
    expect(factors.length).toBeGreaterThan(0);
  });
});

describe("buildApproval", () => {
  const MAX_UINT256 = (1n << 256n) - 1n;

  it("flags allowances >= 2^255 as unlimited", () => {
    const a = buildApproval(TOKEN, UNKNOWN_SPENDER, "USDC", MAX_UINT256, { contractAge: 3, verified: false }, OWNER, "eoa");
    expect(a.isMaxApproval).toBe(true);
    expect(a.amount).toBe("MAX (unlimited)");
  });

  it("keeps bounded allowances as exact amounts", () => {
    const a = buildApproval(TOKEN, UNKNOWN_SPENDER, "USDC", 5_000_000n, { contractAge: 3, verified: false }, OWNER, "eoa");
    expect(a.isMaxApproval).toBe(false);
    expect(a.amount).toBe("5000000");
  });

  it("maps risk to status bands: threat > 75, analyzing > 40, else safe", () => {
    const threat = buildApproval(TOKEN, UNKNOWN_SPENDER, "USDC", MAX_UINT256, { contractAge: 1, verified: false }, OWNER, "eoa");
    expect(threat.riskScore).toBe(95);
    expect(threat.status).toBe("threat");

    // max(30) + unknown spender(20) = 50, verified + old: analyzing band
    const mid = buildApproval(TOKEN, UNKNOWN_SPENDER, "USDC", MAX_UINT256, { contractAge: 365, verified: true }, OWNER, "eoa");
    expect(mid.riskScore).toBe(50);
    expect(mid.status).toBe("analyzing");

    // bounded + unknown info = exactly 40 — boundary stays "safe" (strict >)
    const boundary = buildApproval(TOKEN, UNKNOWN_SPENDER, "USDC", 100n, { contractAge: null, verified: null }, OWNER, "eoa");
    expect(boundary.riskScore).toBe(40);
    expect(boundary.status).toBe("safe");

    const safe = buildApproval(TOKEN, UNISWAP_ROUTER, "USDC", 100n, { contractAge: null, verified: null }, OWNER, "eoa");
    expect(safe.status).toBe("safe");
  });

  it("trusts KNOWN_SAFE labels over (missing) Etherscan info", () => {
    const a = buildApproval(TOKEN, UNISWAP_ROUTER, "USDC", MAX_UINT256, { contractAge: null, verified: null }, OWNER, "eoa");
    expect(a.spenderLabel).toBe("Uniswap Universal Router");
    expect(a.verified).toBe(true);
    expect(a.riskScore).toBe(15);
  });

  it("builds a stable id from owner, token and spender", () => {
    const a = buildApproval(TOKEN, UNKNOWN_SPENDER, "USDC", 1n, { contractAge: null, verified: null }, OWNER, "smart-account");
    expect(a.id).toBe(`${OWNER}-${TOKEN}-${UNKNOWN_SPENDER}`);
    expect(a.ownerType).toBe("smart-account");
  });

  it("represents unknown contract age as -1 (never fabricated)", () => {
    const a = buildApproval(TOKEN, UNKNOWN_SPENDER, "USDC", 1n, { contractAge: null, verified: null }, OWNER, "eoa");
    expect(a.contractAge).toBe(-1);
  });
});

describe("RPC error classification", () => {
  it("collects text across the nested viem cause chain", () => {
    const err = {
      message: "outer",
      cause: { details: "inner details", cause: { shortMessage: "deepest" } },
    };
    const text = collectErrorText(err);
    expect(text).toContain("outer");
    expect(text).toContain("inner details");
    expect(text).toContain("deepest");
  });

  it("detects rate limiting from status code or message, even nested", () => {
    expect(isRateLimitError(new Error("HTTP 429"))).toBe(true);
    expect(isRateLimitError({ cause: { details: "Too Many Requests" } })).toBe(true);
    expect(isRateLimitError(new Error("execution reverted"))).toBe(false);
  });

  it("distinguishes range-cap errors from rate limits", () => {
    const rangeErr = { cause: { details: "You can make eth_getLogs requests with up to a 10 block range." } };
    expect(isRangeLimitError(rangeErr)).toBe(true);
    expect(isRateLimitError(rangeErr)).toBe(false);
    expect(isRangeLimitError(new Error("query returned more than 10000 results"))).toBe(true);
    expect(isRangeLimitError(new Error("nonce too low"))).toBe(false);
  });

  it("parses Alchemy's 'up to a N block range' phrasing", () => {
    const err = new Error("eth_getLogs requests with up to a 10 block range");
    expect(parseAllowedRange(err)).toBe(10n);
  });

  it("parses a suggested [from, to] hex range into a span", () => {
    const err = new Error("Try with this block range [0x64, 0xc7].");
    expect(parseAllowedRange(err)).toBe(0xc7n - 0x64n + 1n);
  });

  it("rejects an inverted suggested range and returns null when nothing matches", () => {
    expect(parseAllowedRange(new Error("range [0xc7, 0x64]"))).toBeNull();
    expect(parseAllowedRange(new Error("some unrelated failure"))).toBeNull();
  });
});

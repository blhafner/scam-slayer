/**
 * demo.ts — demo-mode fixtures and deterministic mock verdicts.
 *
 * Lets the full dashboard flow (scan → analyze → kill) run with no MetaMask,
 * no API keys, and no network. Verdicts are evidence-grounded: derived from the
 * context string the dashboard builds (heuristic risk score, spender label) or
 * from suspicious URL keywords.
 */

import type { Address } from "viem";
import type { PhishingAnalysis } from "./lib/types";

// Fabricated-but-labelled addresses used only when exploring the demo without a
// wallet, so the full dashboard is reachable with zero setup.
export const DEMO_ADDRS = {
  operator: "0x7f3a9Bc1D2E4F5A6B7C8D9E0F1A2B3C4D5E6F7A8" as Address,
  agent: "0xA1b2C3d4E5F60718293A4b5C6d7E8F9012345678" as Address,
  subAgent: "0xB2c3D4e5F60718293a4B5c6D7e8F90123456789A" as Address,
};

export function createDemoAnalysis(opts: {
  imageBase64?: string;
  context?: string;
}): PhishingAnalysis {
  const ctx = opts.context || "";
  const scoreMatch = ctx.match(/Risk Score:\s*(\d+)/i);
  const heuristicScore = scoreMatch ? Number(scoreMatch[1]) : null;
  const labelMatch = ctx.match(/Spender Label:\s*(.+)/i);
  const spenderLabel = labelMatch ? labelMatch[1].trim() : "";

  if (opts.imageBase64) {
    return {
      is_phishing: true,
      confidence: 91,
      brand_impersonated: "MetaMask",
      indicators: [
        "UI clones the MetaMask connect modal",
        "Requests unlimited token approval on first visit",
        "Domain uses look-alike characters (rn → m)",
      ],
      reasoning:
        "The screenshot imitates the MetaMask wallet-connect flow and immediately solicits an unlimited ERC-20 approval — a hallmark of approval-drainer phishing. [Demo verdict]",
    };
  }

  // Threat-card analysis (has a heuristic score).
  if (heuristicScore !== null) {
    if (heuristicScore > 75) {
      return {
        is_phishing: true,
        confidence: Math.min(98, heuristicScore + 5),
        brand_impersonated:
          spenderLabel && spenderLabel !== "UNKNOWN" ? spenderLabel : "Uniswap",
        indicators: [
          "Unlimited approval to an unlabelled spender",
          "Spender contract is unverified and newly deployed",
          "Approval pattern matches known drainer contracts",
        ],
        reasoning:
          "An unlimited approval granted to a freshly-deployed, unverified contract with no known reputation is the classic approval-drainer setup. Revoking neutralizes the risk. [Demo verdict]",
      };
    }
    return {
      is_phishing: false,
      confidence: Math.max(60, 100 - heuristicScore),
      brand_impersonated: null,
      indicators: ["Spender is a known/labelled router", "Bounded or low-risk allowance"],
      reasoning:
        "The spender resolves to a recognized, verified contract and the approval profile is within normal bounds. No phishing indicators present. [Demo verdict]",
    };
  }

  // URL analysis — naive keyword heuristic for the demo.
  const url = ctx.replace(/Analyze (for phishing:|this[^:]*:)/i, "").trim();
  const suspicious =
    /(claim|airdrop|free|connect-wallet|verify|unlock|gift|bonus|-)/i.test(url) &&
    !/(uniswap\.org|app\.uniswap|metamask\.io|opensea\.io)/i.test(url);
  if (url && suspicious) {
    return {
      is_phishing: true,
      confidence: 84,
      brand_impersonated: "Uniswap",
      indicators: [
        "URL contains bait keywords (claim/airdrop/free)",
        "Not the official brand domain",
        "Likely wallet-drainer landing page",
      ],
      reasoning: `"${url.slice(0, 80)}" uses classic phishing bait terms and is not an official domain. Treat as hostile. [Demo verdict]`,
    };
  }
  if (url) {
    return {
      is_phishing: false,
      confidence: 28,
      brand_impersonated: null,
      indicators: ["Insufficient evidence", "No overt phishing markers in the URL"],
      reasoning: `No strong phishing indicators detected for "${url.slice(0, 80)}". Inconclusive on URL alone — inspect the live page. [Demo verdict]`,
    };
  }

  return {
    is_phishing: false,
    confidence: 20,
    brand_impersonated: null,
    indicators: ["Insufficient evidence"],
    reasoning: "Not enough signal to produce a confident verdict in demo mode. [Demo verdict]",
  };
}

export function createUnavailableAnalysis(reason: string): PhishingAnalysis {
  return {
    is_phishing: false,
    confidence: 0,
    brand_impersonated: null,
    indicators: ["Analysis unavailable", reason],
    reasoning: `Could not produce an evidence-based Venice verdict: ${reason}.`,
  };
}

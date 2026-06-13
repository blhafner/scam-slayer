/**
 * x402.ts — Pay-per-inference via the x402 protocol (USDC on Base).
 *
 * Instead of a Venice API key, the agent pays for its own threat intelligence
 * per request using its EOA wallet. Venice returns HTTP 402 when the balance is
 * insufficient; venice-x402-client signs an ERC-3009 transferWithAuthorization
 * (x402 "exact" scheme) with the agent key and Venice's facilitator submits it
 * on Base — no account, no key handover, no human in the loop.
 *
 * Spend is NOT bounded on-chain by the ERC-7710 budget delegation: the ERC-3009
 * transfer is a direct USDC call that never passes through the DelegationManager,
 * so the ERC20TransferAmount enforcer cannot observe it. The cap is enforced
 * client-side (budget.spentUsd >= budget.capUsd in App.tsx) as a UX guard; the
 * only on-chain limit is the agent wallet's funded USDC balance. The operator's
 * signed budget delegation (createBudgetDelegation in wallet.ts) is a revocable
 * off-chain spend mandate, not a trustless on-chain cap.
 */

import { VeniceClient } from "venice-x402-client";
import type { Hex } from "viem";
import type { PhishingAnalysis } from "./types";
import { SYSTEM_PROMPT, parseAnalysis, VISION_MODEL, TEXT_MODEL } from "./venice";

const CHAT_PATH = "/api/v1/chat/completions";

export interface X402Balance {
  balanceUsd: number;
  diemBalanceUsd: number;
  canConsume: boolean;
  minimumTopUpUsd: number;
  suggestedTopUpUsd: number;
}

export interface X402AnalysisResult {
  analysis: PhishingAnalysis;
  /** USDC spent on this request (balance delta), if observable. */
  spentUsd: number;
  balanceAfter: number;
  modelUsed?: string;
}

export interface X402TopUpRequirement {
  network: string;
  asset: string;
  minimumTopUpUsd: number;
}

// Venice enforces a server-side minimum top-up to convert on-chain wallet USDC
// into spendable x402 credit. The wallet's on-chain balance alone is NOT usable
// for inference — it must be topped up once, after which each call costs a few
// tenths of a cent against the credited balance.
const VENICE_MIN_TOPUP_USD = 5;

function client(privateKey: Hex, autoTopUpUsd = VENICE_MIN_TOPUP_USD): VeniceClient {
  return new VeniceClient(privateKey, {
    autoTopUp: { enabled: true, amount: autoTopUpUsd },
  });
}

/**
 * Analyze a screenshot or text context via x402-paid Venice inference.
 * The agent's wallet pays USDC on Base; no API key is used.
 */
export async function analyzeViaX402(
  privateKey: Hex,
  opts: { imageBase64?: string; context?: string }
): Promise<X402AnalysisResult> {
  const c = client(privateKey);
  const before = await c.getBalance().catch(() => null);

  const isVision = !!opts.imageBase64;
  const model = isVision ? VISION_MODEL : TEXT_MODEL;

  const userContent = isVision
    ? [
        {
          type: "image_url",
          image_url: {
            url: opts.imageBase64!.startsWith("data:")
              ? opts.imageBase64!
              : `data:image/png;base64,${opts.imageBase64!}`,
          },
        },
        {
          type: "text",
          text:
            opts.context ||
            "Analyze this Web3 dApp screenshot for phishing/scam indicators.",
        },
      ]
    : opts.context || "";

  let data: any;
  try {
    data = await c.request<any>(CHAT_PATH, {
      method: "POST",
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      temperature: 0.1,
      max_tokens: 2048,
      // disable_thinking: reasoning models otherwise burn the token budget on
      // hidden chain-of-thought and return empty content, breaking JSON parsing.
      venice_parameters: {
        include_venice_system_prompt: false,
        disable_thinking: true,
      },
    }),
  });
  } catch (error: any) {
    const code = error?.code ? String(error.code) : "X402_ERROR";
    const details = error?.details ? ` details=${JSON.stringify(error.details)}` : "";
    throw new Error(`${code}: ${error?.message || "x402 request failed"}${details}`);
  }

  const after = await c.getBalance().catch(() => null);
  const balanceAfter = after?.balanceUsd ?? 0;
  const spentUsd =
    before && after ? Math.max(0, before.balanceUsd - after.balanceUsd) : 0;

  const message = data?.choices?.[0]?.message ?? {};
  return {
    analysis: parseAnalysis(message.content || message.reasoning_content || ""),
    spentUsd,
    balanceAfter,
    modelUsed: data?.model,
  };
}

export async function getX402Balance(privateKey: Hex): Promise<X402Balance> {
  return client(privateKey).getBalance();
}

export async function getX402WalletAddress(privateKey: Hex): Promise<string> {
  return client(privateKey).address;
}

function parseRequirementHeader(encodedHeader: string | null): any | null {
  if (!encodedHeader) return null;
  try {
    const decoded = atob(encodedHeader);
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function toUsd(baseUnits: unknown): number {
  const asNumber = Number(baseUnits ?? 0);
  if (!Number.isFinite(asNumber)) return 0;
  return asNumber / 10 ** 6;
}

export async function getX402TopUpRequirement(): Promise<X402TopUpRequirement | null> {
  const reqResponse = await fetch("https://api.venice.ai/api/v1/x402/top-up", {
    method: "POST",
  });
  if (reqResponse.status !== 402) return null;

  let payload: any = null;
  try {
    payload = await reqResponse.clone().json();
  } catch {
    payload = parseRequirementHeader(reqResponse.headers.get("PAYMENT-REQUIRED"));
  }
  const accepts = payload?.accepts;
  if (!Array.isArray(accepts) || !accepts.length) return null;

  const preferred =
    accepts.find(
      (requirement: any) =>
        String(requirement?.asset || "").toLowerCase() ===
        "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
    ) || accepts[0];

  return {
    network: String(preferred?.network || "unknown"),
    asset: String(preferred?.asset || "unknown"),
    minimumTopUpUsd: toUsd(preferred?.amount),
  };
}

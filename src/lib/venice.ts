/**
 * venice.ts — Venice AI integration for phishing detection
 *
 * Uses Venice's OpenAI-compatible API with zero data retention.
 *
 * Model: qwen3-5-35b-a3b — vision + reasoning, 256k context, ~$0.31/$1.25 per
 * 1M tokens. Chosen for best intelligence-per-dollar with both image and text
 * understanding, so a single reasoning-capable model serves screenshot and
 * URL/contract analysis. (Previously llama-3.3-70b had no reasoning/vision and
 * qwen3-vl had no reasoning, which produced weak verdicts.)
 */

import type { PhishingAnalysis } from "./types";
import { getProxyUrl } from "./proxy";

const VENICE_BASE = "https://api.venice.ai/api/v1";
// Unified reasoning + vision model for both screenshot and text analysis.
const ANALYSIS_MODEL = "qwen3-5-35b-a3b";
const VISION_MODEL = ANALYSIS_MODEL;
const TEXT_MODEL = ANALYSIS_MODEL;

export interface VeniceAnalysisResult {
  analysis: PhishingAnalysis;
  modelUsed?: string;
}

function normalizeVeniceApiKey(rawApiKey: string): string {
  return rawApiKey
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^['"]|['"]$/g, "");
}

export const SYSTEM_PROMPT = `You are a Web3 security analyst specializing in phishing and scam detection.

CRITICAL RELIABILITY RULES:
- Use ONLY evidence explicitly present in the user-provided content.
- Do NOT invent brand names, domains, contracts, screenshots, or attack details.
- If evidence is insufficient or ambiguous, return a LOW-CONFIDENCE inconclusive result:
  is_phishing=false, confidence<=35, brand_impersonated=null,
  indicators includes "Insufficient evidence".
- Only return is_phishing=true when there are clear, explicit malicious indicators in the provided content.
- "brand_impersonated" is the legitimate dApp/brand a SCAM is impersonating (e.g. "Uniswap", "MetaMask"). It is NOT the token symbol or spender being analyzed. If nothing is being impersonated, set it to null.

You MUST respond with ONLY valid JSON, no markdown fences, no explanation outside the JSON:
{"is_phishing":boolean,"confidence":0-100,"brand_impersonated":string|null,"indicators":["string array of specific findings"],"reasoning":"one paragraph summary grounded in the provided evidence"}`;

export async function analyzeScreenshot(
  apiKey: string,
  imageBase64: string,
  additionalContext?: string
): Promise<PhishingAnalysis> {
  const result = await analyzeScreenshotDetailed(apiKey, imageBase64, additionalContext);
  return result.analysis;
}

export async function analyzeScreenshotDetailed(
  apiKey: string,
  imageBase64: string,
  additionalContext?: string
): Promise<VeniceAnalysisResult> {
  const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

  // Add image
  const dataUrl = imageBase64.startsWith("data:")
    ? imageBase64
    : `data:image/png;base64,${imageBase64}`;
  content.push({ type: "image_url", image_url: { url: dataUrl } });

  // Add text context
  content.push({
    type: "text",
    text: additionalContext || "Analyze this Web3 dApp screenshot for phishing/scam indicators.",
  });

  return callVenice(apiKey, VISION_MODEL, content);
}

export async function analyzeUrl(
  apiKey: string,
  context: string
): Promise<PhishingAnalysis> {
  const result = await analyzeUrlDetailed(apiKey, context);
  return result.analysis;
}

export async function analyzeUrlDetailed(
  apiKey: string,
  context: string
): Promise<VeniceAnalysisResult> {
  return callVenice(apiKey, TEXT_MODEL, [{ type: "text", text: context }]);
}

async function callVenice(
  apiKey: string,
  model: string,
  content: Array<{ type: string; text?: string; image_url?: { url: string } }>
): Promise<VeniceAnalysisResult> {
  // With a secret proxy configured the worker injects the key server-side, so
  // no client key is required; otherwise a key is mandatory.
  const proxy = getProxyUrl();
  const key = normalizeVeniceApiKey(apiKey);
  if (!proxy && !key) {
    throw new Error("Venice API key is missing");
  }

  const res = await fetch(proxy ? `${proxy}/venice/chat` : `${VENICE_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      ...(proxy ? {} : { Authorization: `Bearer ${key}` }),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
      temperature: 0.1,
      max_tokens: 2048,
      // disable_thinking keeps reasoning models from spending the whole token
      // budget on hidden chain-of-thought (which left `content` empty and broke
      // JSON parsing). It returns the structured verdict directly and fast.
      venice_parameters: {
        include_venice_system_prompt: false,
        disable_thinking: true,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Venice API ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const message = data.choices?.[0]?.message ?? {};
  return {
    analysis: parseAnalysis(message.content || message.reasoning_content || ""),
    modelUsed: data?.model,
  };
}

/**
 * Parse the model's chat completion content into a PhishingAnalysis.
 * Shared by the API-key path (this file) and the x402 path (x402.ts).
 */
export function parseAnalysis(raw: string): PhishingAnalysis {
  // Reasoning models often wrap JSON in <think> traces, markdown fences, or
  // surrounding prose. Strip those, then fall back to extracting the first
  // balanced {...} object so a verdict still parses.
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const cleaned = withoutThink
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  const candidates = [cleaned, extractFirstJsonObject(cleaned)].filter(
    (c): c is string => !!c
  );

  for (const candidate of candidates) {
    try {
      return sanitizeAnalysis(JSON.parse(candidate));
    } catch {
      /* try next candidate */
    }
  }

  console.warn("Venice response was not valid JSON:", raw);
  return {
    is_phishing: false,
    confidence: 0,
    brand_impersonated: null,
    indicators: ["Failed to parse AI response — manual review required"],
    reasoning: raw.slice(0, 500),
  };
}

/** Extract the first balanced top-level JSON object from a string, if present. */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function sanitizeAnalysis(value: unknown): PhishingAnalysis {
  const parsed = (value || {}) as Partial<PhishingAnalysis>;
  const confidence = Number(parsed.confidence);
  const normalizedConfidence = Number.isFinite(confidence)
    ? Math.max(0, Math.min(100, Math.round(confidence)))
    : 0;
  const indicators = Array.isArray(parsed.indicators)
    ? parsed.indicators
        .filter((indicator): indicator is string => typeof indicator === "string")
        .map((indicator) => indicator.trim())
        .filter(Boolean)
    : [];
  const reasoning =
    typeof parsed.reasoning === "string" && parsed.reasoning.trim()
      ? parsed.reasoning.trim()
      : "Insufficient evidence in model response.";
  const brand =
    typeof parsed.brand_impersonated === "string" &&
    parsed.brand_impersonated.trim()
      ? parsed.brand_impersonated.trim()
      : null;
  const isPhishing = Boolean(parsed.is_phishing);

  if (!isPhishing && normalizedConfidence <= 35 && indicators.length === 0) {
    indicators.push("Insufficient evidence");
  }

  return {
    is_phishing: isPhishing,
    confidence: normalizedConfidence,
    brand_impersonated: brand,
    indicators,
    reasoning,
  };
}

/**
 * Test Venice API key by hitting the /models endpoint.
 */
export async function testApiKey(apiKey: string): Promise<boolean> {
  try {
    const proxy = getProxyUrl();
    const key = normalizeVeniceApiKey(apiKey);
    // In proxy mode this exercises the worker's server-side key, not a client one.
    if (!proxy && !key) return false;
    const res = await fetch(proxy ? `${proxy}/venice/chat` : `${VENICE_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        ...(proxy ? {} : { Authorization: `Bearer ${key}` }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TEXT_MODEL,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Get available models (useful for verification).
 */
export async function listModels(apiKey: string): Promise<string[]> {
  const key = normalizeVeniceApiKey(apiKey);
  if (!key) return [];
  const res = await fetch(`${VENICE_BASE}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || []).map((m: { id: string }) => m.id);
}

export { VISION_MODEL, TEXT_MODEL };

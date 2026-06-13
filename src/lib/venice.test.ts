/**
 * venice.test.ts — parseAnalysis is the single point where raw model output
 * becomes a PhishingAnalysis verdict (shared by the API-key and x402 paths).
 * A parsing regression here silently corrupts every kill decision, so each
 * known model-output shape is pinned down.
 */
import { describe, it, expect } from "vitest";
import { parseAnalysis } from "./venice";

const VALID = {
  is_phishing: true,
  confidence: 92,
  brand_impersonated: "Uniswap",
  indicators: ["lookalike domain", "unverified contract"],
  reasoning: "Domain mimics app.uniswap.org and requests unlimited approval.",
};

describe("parseAnalysis", () => {
  it("parses a clean JSON object", () => {
    const result = parseAnalysis(JSON.stringify(VALID));
    expect(result).toEqual(VALID);
  });

  it("strips <think> reasoning traces before the JSON", () => {
    const raw = `<think>\nthe user gave me a token approval...\n{not json}\n</think>\n${JSON.stringify(VALID)}`;
    expect(parseAnalysis(raw)).toEqual(VALID);
  });

  it("strips markdown code fences", () => {
    const raw = "```json\n" + JSON.stringify(VALID) + "\n```";
    expect(parseAnalysis(raw)).toEqual(VALID);
  });

  it("extracts the first balanced JSON object from surrounding prose", () => {
    const raw = `Here is my assessment:\n${JSON.stringify(VALID)}\nLet me know if you need more detail.`;
    expect(parseAnalysis(raw)).toEqual(VALID);
  });

  it("handles braces and escaped quotes inside JSON strings", () => {
    const tricky = {
      ...VALID,
      reasoning: 'Contains {braces} and an escaped quote: \\" plus } extra',
    };
    const raw = `verdict: ${JSON.stringify(tricky)} trailing }`;
    expect(parseAnalysis(raw)).toEqual(tricky);
  });

  it("returns the safe fallback (not a throw) on unparseable output", () => {
    const result = parseAnalysis("the model rambled and produced no JSON at all");
    expect(result.is_phishing).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.brand_impersonated).toBeNull();
    expect(result.indicators).toContain(
      "Failed to parse AI response — manual review required"
    );
  });

  it("fallback reasoning is capped at 500 chars of the raw output", () => {
    const result = parseAnalysis("x".repeat(2000));
    expect(result.reasoning).toHaveLength(500);
  });

  it("clamps confidence into 0..100 and rounds it", () => {
    expect(parseAnalysis(JSON.stringify({ ...VALID, confidence: 250 })).confidence).toBe(100);
    expect(parseAnalysis(JSON.stringify({ ...VALID, confidence: -5 })).confidence).toBe(0);
    expect(parseAnalysis(JSON.stringify({ ...VALID, confidence: 41.6 })).confidence).toBe(42);
  });

  it("treats a non-numeric confidence as 0", () => {
    const result = parseAnalysis(JSON.stringify({ ...VALID, confidence: "very high" }));
    expect(result.confidence).toBe(0);
  });

  it("coerces is_phishing to a strict boolean", () => {
    expect(parseAnalysis(JSON.stringify({ ...VALID, is_phishing: "yes" })).is_phishing).toBe(true);
    expect(parseAnalysis(JSON.stringify({ ...VALID, is_phishing: 0 })).is_phishing).toBe(false);
  });

  it("drops non-string and blank indicators", () => {
    const raw = JSON.stringify({
      ...VALID,
      indicators: ["  real signal  ", 42, null, "", { nested: true }],
    });
    expect(parseAnalysis(raw).indicators).toEqual(["real signal"]);
  });

  it("normalizes a blank brand_impersonated to null", () => {
    const raw = JSON.stringify({ ...VALID, brand_impersonated: "   " });
    expect(parseAnalysis(raw).brand_impersonated).toBeNull();
  });

  it("injects the 'Insufficient evidence' indicator on low-confidence clean verdicts", () => {
    const raw = JSON.stringify({
      is_phishing: false,
      confidence: 20,
      brand_impersonated: null,
      indicators: [],
      reasoning: "Nothing conclusive.",
    });
    expect(parseAnalysis(raw).indicators).toEqual(["Insufficient evidence"]);
  });

  it("does NOT inject 'Insufficient evidence' when confidence is high", () => {
    const raw = JSON.stringify({
      is_phishing: false,
      confidence: 90,
      brand_impersonated: null,
      indicators: [],
      reasoning: "Clearly benign.",
    });
    expect(parseAnalysis(raw).indicators).toEqual([]);
  });

  it("defaults missing reasoning to the insufficient-evidence message", () => {
    const raw = JSON.stringify({ is_phishing: true, confidence: 80 });
    expect(parseAnalysis(raw).reasoning).toBe("Insufficient evidence in model response.");
  });
});

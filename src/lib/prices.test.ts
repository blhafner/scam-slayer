/**
 * prices.test.ts — dollar-at-risk exposure math + DefiLlama price plumbing.
 *
 * Exposure is the number the dashboard sorts and headlines by, so its honesty
 * rules are pinned here: min(balance, allowance), never fabricated when an
 * input is unknown, and unlimited approvals bounded by what the wallet holds.
 */

import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import {
  buildPriceKeys,
  parseLlamaPrices,
  computeExposure,
  formatUsd,
} from "./prices";

const MAX_UINT256 = (1n << 256n) - 1n;
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
const WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9" as Address;

describe("computeExposure", () => {
  it("bounds an unlimited approval by the wallet balance", () => {
    // MAX allowance, wallet holds 250 USDC (6 decimals) → only 250 at risk.
    const e = computeExposure(MAX_UINT256, 250_000_000n, 6, 1);
    expect(e.exposureTokens).toBe(250);
    expect(e.exposureUsd).toBe(250);
  });

  it("bounds a large balance by the allowance", () => {
    // Wallet holds 12,400 DAI but spender may only take 5,000.
    const e = computeExposure(
      5_000n * 10n ** 18n,
      12_400n * 10n ** 18n,
      18,
      1
    );
    expect(e.exposureTokens).toBe(5000);
    expect(e.exposureUsd).toBe(5000);
  });

  it("multiplies by price with decimals applied", () => {
    // 1.85 WETH at risk @ $2,000.
    const e = computeExposure(MAX_UINT256, 1_850_000_000_000_000_000n, 18, 2000);
    expect(e.exposureTokens).toBeCloseTo(1.85);
    expect(e.exposureUsd).toBeCloseTo(3700);
  });

  it("returns $0 (not unknown) for an empty wallet — unlimited approval, nothing to drain", () => {
    const e = computeExposure(MAX_UINT256, 0n, 18, 2000);
    expect(e.exposureTokens).toBe(0);
    expect(e.exposureUsd).toBe(0);
  });

  it("keeps token units but null USD when no price is known", () => {
    const e = computeExposure(100n * 10n ** 18n, 50n * 10n ** 18n, 18, null);
    expect(e.exposureTokens).toBe(50);
    expect(e.exposureUsd).toBeNull();
  });

  it("returns fully unknown when balance or decimals could not be read", () => {
    expect(computeExposure(1n, null, 18, 1)).toEqual({
      exposureTokens: null,
      exposureUsd: null,
    });
    expect(computeExposure(1n, 1n, null, 1)).toEqual({
      exposureTokens: null,
      exposureUsd: null,
    });
  });
});

describe("buildPriceKeys", () => {
  it("uses chain:address keys on mainnet chains", () => {
    const keys = buildPriceKeys(8453, [{ address: USDC, symbol: "USDC" }]);
    expect(keys.get(USDC.toLowerCase())).toBe(`base:${USDC.toLowerCase()}`);
  });

  it("maps well-known testnet symbols to coingecko ids (Sepolia has no markets)", () => {
    const keys = buildPriceKeys(11155111, [
      { address: USDC, symbol: "USDC" },
      { address: WETH, symbol: "weth" }, // case-insensitive
    ]);
    expect(keys.get(USDC.toLowerCase())).toBe("coingecko:usd-coin");
    expect(keys.get(WETH.toLowerCase())).toBe("coingecko:weth");
  });

  it("omits unknown testnet tokens instead of guessing a price", () => {
    const keys = buildPriceKeys(11155111, [{ address: USDC, symbol: "SCAMCOIN" }]);
    expect(keys.size).toBe(0);
  });

  it("dedupes repeated token addresses", () => {
    const keys = buildPriceKeys(1, [
      { address: USDC, symbol: "USDC" },
      { address: USDC, symbol: "USDC" },
    ]);
    expect(keys.size).toBe(1);
  });
});

describe("parseLlamaPrices", () => {
  const keyByAddr = new Map([
    [USDC.toLowerCase(), "coingecko:usd-coin"],
    [WETH.toLowerCase(), "coingecko:weth"],
  ]);

  it("maps llama coin prices back to token addresses", () => {
    const prices = parseLlamaPrices(
      {
        coins: {
          "coingecko:usd-coin": { price: 0.9998 },
          "coingecko:weth": { price: 2276.4 },
        },
      },
      keyByAddr
    );
    expect(prices.get(USDC.toLowerCase())).toBe(0.9998);
    expect(prices.get(WETH.toLowerCase())).toBe(2276.4);
  });

  it("skips missing or malformed entries and survives junk responses", () => {
    const prices = parseLlamaPrices(
      { coins: { "coingecko:usd-coin": { price: "not-a-number" } } },
      keyByAddr
    );
    expect(prices.size).toBe(0);
    expect(parseLlamaPrices(null, keyByAddr).size).toBe(0);
    expect(parseLlamaPrices({ unexpected: true }, keyByAddr).size).toBe(0);
  });
});

describe("formatUsd", () => {
  it("formats across magnitudes and keeps unknown honest", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.004)).toBe("$<0.01");
    expect(formatUsd(0.42)).toBe("$0.42");
    expect(formatUsd(1820)).toBe("$1,820");
    expect(formatUsd(4210.7)).toBe("$4,211");
  });
});

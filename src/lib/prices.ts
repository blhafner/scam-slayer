/**
 * prices.ts — token USD prices + dollar-at-risk exposure.
 *
 * Exposure answers the question heuristics can't: "how many dollars can this
 * approval drain RIGHT NOW?"
 *
 *   exposure = min(wallet balance, allowance) × token price
 *
 * An unlimited approval over an empty balance is $0 of immediate risk; a
 * bounded approval over a full wallet can be thousands. Sorting by exposure
 * prioritizes what actually matters.
 *
 * Prices come from DefiLlama's free coins API (no key, batched):
 *   GET https://coins.llama.fi/prices/current/<key>,<key>,...
 * Mainnet chains use `<chain-slug>:<token-address>` keys. Testnets (Sepolia)
 * have no real markets, so well-known symbols map to their canonical CoinGecko
 * ids (`coingecko:<id>`) — a USDC/WETH/LINK test token prices like the real
 * asset, which is what a demo should show. Unknown tokens get NO price and the
 * exposure stays null ("unknown") — never fabricated, consistent with the
 * scanner's honesty rule.
 */

import type { Address } from "viem";

const LLAMA_PRICE_API = "https://coins.llama.fi/prices/current";

// DefiLlama chain slugs for the chains in chains.ts. Testnets are absent on
// purpose — they fall through to the symbol map below.
const LLAMA_CHAIN_SLUGS: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  59144: "linea",
  56: "bsc",
  137: "polygon",
  369: "pulse",
};

// Testnet tokens have no market price; price well-known symbols as their
// canonical mainnet asset via CoinGecko ids.
const SYMBOL_COINGECKO_IDS: Record<string, string> = {
  USDC: "usd-coin",
  USDT: "tether",
  DAI: "dai",
  WETH: "weth",
  ETH: "ethereum",
  WBTC: "wrapped-bitcoin",
  LINK: "chainlink",
  UNI: "uniswap",
  AAVE: "aave",
};

export interface PriceToken {
  address: Address;
  symbol: string;
}

/**
 * Map token addresses (lowercased) to DefiLlama price keys for the given
 * chain. Tokens with no resolvable key are omitted (→ exposure unknown).
 */
export function buildPriceKeys(
  chainId: number,
  tokens: PriceToken[]
): Map<string, string> {
  const slug = LLAMA_CHAIN_SLUGS[chainId];
  const keyByAddr = new Map<string, string>();
  for (const t of tokens) {
    const addr = t.address.toLowerCase();
    if (keyByAddr.has(addr)) continue;
    if (slug) {
      keyByAddr.set(addr, `${slug}:${addr}`);
    } else {
      const id = SYMBOL_COINGECKO_IDS[t.symbol.toUpperCase()];
      if (id) keyByAddr.set(addr, `coingecko:${id}`);
    }
  }
  return keyByAddr;
}

/** Parse a DefiLlama /prices/current response into address → USD price. */
export function parseLlamaPrices(
  json: unknown,
  keyByAddr: Map<string, string>
): Map<string, number> {
  const out = new Map<string, number>();
  const coins = (json as any)?.coins;
  if (!coins || typeof coins !== "object") return out;
  for (const [addr, key] of keyByAddr) {
    const price = Number(coins[key]?.price);
    if (Number.isFinite(price) && price >= 0) out.set(addr, price);
  }
  return out;
}

// Session cache so the 30s rescan loop doesn't hammer the price API.
const PRICE_TTL_MS = 5 * 60_000;
const priceCache = new Map<string, { price: number; ts: number }>();

/**
 * Fetch USD prices for the given tokens, batched in one request and cached for
 * 5 minutes. Returns lowercased-address → price; tokens without a price are
 * absent. Never throws — a failed fetch returns whatever the cache has.
 */
export async function fetchTokenPricesUsd(
  chainId: number,
  tokens: PriceToken[]
): Promise<Map<string, number>> {
  const keyByAddr = buildPriceKeys(chainId, tokens);
  const result = new Map<string, number>();
  const missing = new Map<string, string>();
  const now = Date.now();

  for (const [addr, key] of keyByAddr) {
    const cached = priceCache.get(key);
    if (cached && now - cached.ts < PRICE_TTL_MS) {
      result.set(addr, cached.price);
    } else {
      missing.set(addr, key);
    }
  }
  if (!missing.size) return result;

  try {
    const keys = [...new Set(missing.values())].join(",");
    const res = await fetch(`${LLAMA_PRICE_API}/${keys}`);
    if (!res.ok) return result;
    const fetched = parseLlamaPrices(await res.json(), missing);
    for (const [addr, price] of fetched) {
      result.set(addr, price);
      priceCache.set(missing.get(addr)!, { price, ts: now });
    }
  } catch {
    /* price API down — exposures stay unknown */
  }
  return result;
}

export interface Exposure {
  /** Token units actually at risk: min(balance, allowance). null = balance unknown. */
  exposureTokens: number | null;
  /** Dollar value of exposureTokens. null = price or balance unknown. */
  exposureUsd: number | null;
}

/**
 * Dollar-at-risk for one approval: min(balance, allowance) × price.
 * Unknown inputs (failed balance/decimals read, no price) yield null — shown
 * as "exposure ?" in the UI rather than a made-up number.
 */
export function computeExposure(
  allowance: bigint,
  balance: bigint | null,
  decimals: number | null,
  priceUsd: number | null
): Exposure {
  if (balance === null || decimals === null) {
    return { exposureTokens: null, exposureUsd: null };
  }
  const atRiskRaw = allowance < balance ? allowance : balance;
  const exposureTokens = Number(atRiskRaw) / 10 ** decimals;
  return {
    exposureTokens,
    exposureUsd: priceUsd === null ? null : exposureTokens * priceUsd,
  };
}

/** Compact dollar formatting for the dashboard: $1,820 · $0.42 · $<0.01 · —. */
export function formatUsd(n: number | null): string {
  if (n === null) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return "$<0.01";
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

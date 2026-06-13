/**
 * proxy.ts — optional secret-proxy routing.
 *
 * When VITE_PROXY_URL is set (a deployed Cloudflare Worker — see worker/), the
 * client routes Venice inference, JSON-RPC, and Etherscan through it so NO API
 * keys are baked into the bundle (the worker holds them server-side). When
 * unset, every caller falls back to the direct-key behavior, so local dev and
 * the demo keep working unchanged.
 */

export function getProxyUrl(): string | null {
  const raw = import.meta.env.VITE_PROXY_URL;
  if (!raw) return null;
  return String(raw).replace(/\/+$/, "");
}

export function isProxyEnabled(): boolean {
  return getProxyUrl() !== null;
}

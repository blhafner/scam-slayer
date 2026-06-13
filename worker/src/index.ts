/**
 * Scam Slayer secret proxy — Cloudflare Worker.
 *
 * Holds every third-party API key server-side and exposes three narrow,
 * CORS-locked, read-only routes so the client bundle ships ZERO secrets:
 *
 *   POST /venice/chat        → Venice /chat/completions   (injects VENICE_API_KEY)
 *   POST /rpc/:chainId       → chain JSON-RPC (read-only) (injects INFURA_KEY)
 *   GET  /etherscan?...      → Etherscan v2 API           (injects ETHERSCAN_KEY)
 *
 * Secrets are Worker secrets (wrangler secret put …), never in code or the
 * client. Origin is restricted to ALLOWED_ORIGINS. The RPC route rejects any
 * state-changing method, so a leaked endpoint can read but never send a tx.
 */

export interface Env {
  VENICE_API_KEY: string;
  INFURA_KEY: string;
  ETHERSCAN_KEY: string;
  ALLOWED_ORIGINS: string; // comma-separated; "*" allows any (dev only)
}

const VENICE_CHAT_URL = "https://api.venice.ai/api/v1/chat/completions";
const ETHERSCAN_V2_API = "https://api.etherscan.io/v2/api";

// chainId → upstream JSON-RPC. Mirrors src/lib/chains.ts. Infura-backed chains
// use the server INFURA_KEY; PulseChain uses its public RPC (no key).
const RPC_UPSTREAM: Record<string, (env: Env) => string> = {
  "1": (e) => `https://mainnet.infura.io/v3/${e.INFURA_KEY}`,
  "11155111": (e) => `https://sepolia.infura.io/v3/${e.INFURA_KEY}`,
  "8453": (e) => `https://base-mainnet.infura.io/v3/${e.INFURA_KEY}`,
  "59144": (e) => `https://linea-mainnet.infura.io/v3/${e.INFURA_KEY}`,
  "56": (e) => `https://bsc-mainnet.infura.io/v3/${e.INFURA_KEY}`,
  "137": (e) => `https://polygon-mainnet.infura.io/v3/${e.INFURA_KEY}`,
  "369": () => "https://rpc.pulsechain.com",
};

// JSON-RPC methods the proxy will forward. Read-only by construction — no
// eth_sendRawTransaction, no account/key methods. A leaked URL can't move funds.
const RPC_METHOD_ALLOWLIST = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_call",
  "eth_getLogs",
  "eth_getCode",
  "eth_getBalance",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionCount",
  "eth_gasPrice",
  "eth_feeHistory",
  "eth_maxPriorityFeePerGas",
  "eth_estimateGas",
]);

// Etherscan modules the proxy will forward (contract metadata reads only).
const ETHERSCAN_ACTION_ALLOWLIST = new Set(["getsourcecode", "getcontractcreation", "getabi"]);

// Best-effort per-isolate rate limit. NOTE: Workers run many isolates, so this
// is a coarse abuse backstop, not a hard quota — use KV/Durable Objects or
// Cloudflare Rate Limiting Rules for real per-client limits in production.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
const hits = new Map<string, { count: number; reset: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const cur = hits.get(ip);
  if (!cur || now > cur.reset) {
    hits.set(ip, { count: 1, reset: now + RATE_WINDOW_MS });
    return false;
  }
  cur.count++;
  return cur.count > RATE_MAX;
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  const any = allowed.includes("*");
  const ok = origin && (any || allowed.includes(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : any ? "*" : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function originAllowed(origin: string | null, env: Env): boolean {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  if (allowed.includes("*")) return true;
  return !!origin && allowed.includes(origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Browser requests carry an Origin; require it to be on the allowlist.
    if (origin && !originAllowed(origin, env)) {
      return json({ error: "origin not allowed" }, 403, cors);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (rateLimited(ip)) {
      return json({ error: "rate limited" }, 429, cors);
    }

    try {
      // ---- Venice chat ----
      if (url.pathname === "/venice/chat" && request.method === "POST") {
        const body = await request.text();
        const upstream = await fetch(VENICE_CHAT_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.VENICE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body,
        });
        return new Response(await upstream.text(), {
          status: upstream.status,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }

      // ---- JSON-RPC (read-only) ----
      const rpcMatch = url.pathname.match(/^\/rpc\/(\d+)$/);
      if (rpcMatch && request.method === "POST") {
        const chainId = rpcMatch[1];
        const upstreamFor = RPC_UPSTREAM[chainId];
        if (!upstreamFor) return json({ error: `unsupported chain ${chainId}` }, 400, cors);

        const payload = await request.json().catch(() => null);
        const calls = Array.isArray(payload) ? payload : [payload];
        for (const c of calls) {
          const method = c?.method;
          if (typeof method !== "string" || !RPC_METHOD_ALLOWLIST.has(method)) {
            return json({ error: `method not allowed: ${method ?? "?"}` }, 403, cors);
          }
        }

        const upstream = await fetch(upstreamFor(env), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        return new Response(await upstream.text(), {
          status: upstream.status,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }

      // ---- Etherscan v2 ----
      if (url.pathname === "/etherscan" && request.method === "GET") {
        const action = url.searchParams.get("action") || "";
        if (!ETHERSCAN_ACTION_ALLOWLIST.has(action)) {
          return json({ error: `action not allowed: ${action}` }, 403, cors);
        }
        const forward = new URL(ETHERSCAN_V2_API);
        url.searchParams.forEach((v, k) => forward.searchParams.set(k, v));
        forward.searchParams.set("apikey", env.ETHERSCAN_KEY);
        const upstream = await fetch(forward.toString());
        return new Response(await upstream.text(), {
          status: upstream.status,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }

      return json({ error: "not found" }, 404, cors);
    } catch (err: any) {
      return json({ error: err?.message || "proxy error" }, 502, cors);
    }
  },
};

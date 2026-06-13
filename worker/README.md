# Scam Slayer secret proxy

Cloudflare Worker that holds the Venice / Infura / Etherscan API keys
server-side so the web client ships **zero secrets**. Three narrow,
CORS-locked, read-only routes:

| Route | Method | Upstream | Injected secret |
|-------|--------|----------|-----------------|
| `/venice/chat` | POST | Venice `chat/completions` | `VENICE_API_KEY` |
| `/rpc/:chainId` | POST | chain JSON-RPC (read-only allowlist) | `INFURA_KEY` |
| `/etherscan?…` | GET | Etherscan v2 (`getsourcecode`/`getcontractcreation`) | `ETHERSCAN_KEY` |

The RPC route forwards **only read methods** — `eth_sendRawTransaction` and any
state-changing call are rejected, so a leaked endpoint can read chain data but
never move funds. Writes (revocations, UserOps, relays) still go straight from
the user's wallet / bundler / 1Shot, never through this proxy.

## Deploy

```bash
cd worker
npm install
wrangler login

# set secrets (prompts for each value — never commit them)
wrangler secret put VENICE_API_KEY
wrangler secret put INFURA_KEY
wrangler secret put ETHERSCAN_KEY

# set the browser origins allowed to call the proxy (edit wrangler.toml [vars]
# ALLOWED_ORIGINS, or override per-env), then:
npm run deploy
```

`wrangler deploy` prints the worker URL, e.g.
`https://scam-slayer-proxy.<account>.workers.dev`.

## Point the app at it

Set in the app's `.env`:

```
VITE_PROXY_URL=https://scam-slayer-proxy.<account>.workers.dev
```

With `VITE_PROXY_URL` set, the client routes Venice, RPC, and Etherscan through
the worker and needs **no** `VITE_VENICE_API_KEY` / `VITE_ALCHEMY_API_KEY` /
`VITE_ETHERSCAN_API_KEY` in its build. Unset it and the app falls back to the
direct-key behavior for local dev.

## Local dev

```bash
npm run dev        # wrangler dev on http://localhost:8787
```

Add `http://localhost:8787` as `VITE_PROXY_URL` and your dev origin
(`http://localhost:5173`) to `ALLOWED_ORIGINS`. For local secrets, create
`.dev.vars` (gitignored) with `VENICE_API_KEY=…` etc.

## Not proxied

- **Pimlico bundler** and **1Shot relayer** use their own endpoints with their
  own auth and submit transactions — out of scope for a read-only secret proxy.
- **DefiLlama prices** are a keyless public API (called directly).
- **x402** pays Venice with the agent's own wallet (ERC-3009), no API key.

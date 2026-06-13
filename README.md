# 🗡️ Scam Slayer

> **Autonomous AI security agent for your MetaMask Smart Account**

**Tracks:** Best x402 + ERC-7710 · Best Agent · Best A2A Coordination · Best use of Venice AI · Best use of 1Shot Relayer — [MetaMask Smart Accounts Kit × 1Shot API × Venice AI Dev Cook-Off](https://www.hackquest.io/hackathons/MetaMask-Smart-Accounts-Kit-x-1Shot-API-x-Venice-AI-Dev-Cook-Off)

---

## What it does

Scam Slayer is an autonomous security agent that protects your wallet from malicious token approvals. You grant it a scoped ERC-7710 delegation — it can **only** revoke approvals, never spend or transfer. It then:

1. **Scans** your active ERC-20 approvals and scores them against risk heuristics
2. **Analyzes** suspect dApps using Venice AI's unified reasoning + vision model (`qwen3-5-35b-a3b`) with zero data retention
3. **Kills** confirmed threats by autonomously revoking the malicious approval via delegation redemption

No human in the loop for the kill. One delegation, zero trust assumptions.

## How it's built

| Layer | Technology |
|-------|-----------|
| Smart Accounts | `@metamask/smart-accounts-kit` v1.6 — ERC-7710 delegation + A2A redelegation (`functionCall` scope, `limitedCalls`, `timestamp` caveats) |
| AI Vision + Text | Venice AI `qwen3-5-35b-a3b` — one reasoning+vision model for both screenshot phishing detection and URL/contract threat assessment, zero data retention |
| Payments | x402 (`venice-x402-client`) — agent pays per-inference in USDC on Base, no API key |
| Chain Data | Alchemy — Approval-event scan + live `allowance()` reads on Sepolia; Etherscan — real contract age + source verification |
| Bundler | Pimlico — UserOp submission for delegation redemption (default path) |
| Relayer | 1Shot Permissionless Relayer — gas-abstracted ERC-7710 redemption, gas paid in USDC, EIP-7702 account upgrade |
| Frontend | React + Vite + TypeScript |

## Architecture (A2A redelegation)

```
Operator (MetaMask Smart Account)
    │  createDelegation → functionCall scope: approve(addr,0) only
    │  caveats: limitedCalls(10), timestamp(30d expiry)   [signed via MetaMask]
    ▼
Coordinator Agent (Local Smart Account)
    │  createDelegation → parentDelegation: <root>        [signed locally, A2A]
    │  attenuation: limitedCalls(5)
    ▼
Revoker Sub-Agent (Local Smart Account)
    ├── Scanner: polls Alchemy for active approvals → risk scoring
    ├── Analyzer: Venice AI vision → phishing classification
    └── redeemDelegations([[child, root]]) → approve(spender, 0)
```

The Revoker redeems the **full delegation chain** (leaf → root), so the on-chain
`approve(spender, 0)` executes from the Operator's account while every hop is
constrained by inherited + attenuated caveats. This is the ERC-7710 redelegation
that qualifies for the A2A Coordination track.

## Setup

```bash
git clone https://github.com/wrekafekt/scam-slayer.git
cd scam-slayer
npm install
cp .env.example .env   # optional — every key works from the in-app Settings too
npm run dev
```

> **No keys needed to try it.** With an empty `.env`, the app boots in **DEMO
> mode** (full scan → analyze → kill flow on mock data, no wallet) and **LIVE
> mode** works as soon as you paste keys into Settings. Keys are only read at
> build time for convenience; nothing is required to run.

Run the unit tests (risk scoring, AI verdict parsing, RPC error handling) with
`npm test` (or `npm run test:watch` during development).

### Required keys

- **Venice AI** — [venice.ai](https://venice.ai) (free tier works; or use x402 + a USDC-funded Base wallet instead)
- **Alchemy** — [alchemy.com](https://www.alchemy.com/) (free, Sepolia network)
- **Etherscan** — [etherscan.io/apis](https://etherscan.io/apis) (optional — real contract age + verification; `VITE_ETHERSCAN_API_KEY`)
- **Pimlico** — [pimlico.io](https://pimlico.io) (free, for bundler)
- **MetaMask Flask** — [metamask.io/flask](https://metamask.io/flask/) (dev build)

### Sepolia testnet

Fund your wallet via [Alchemy Faucet](https://sepoliafaucet.com/) or [Google Cloud Faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia). Get test USDC from [Circle Faucet](https://faucet.circle.com/).

## Demo

The app works in two modes:

- **DEMO mode** — click **▶ Explore Demo** on the landing page (no MetaMask, no API keys). Loads mock approvals and walks the full flow: scan → analyze (deterministic mock verdicts) → autonomous revoke, with the A2A delegation chain, x402 budget, toasts, and kill log all live.
- **LIVE mode** — connect MetaMask Flask for real Venice AI analysis, real approval scanning, and real on-chain revocation.

### Dashboard features

- **Autonomous Kill Mode** — arm the agent and set a risk threshold; it auto-revokes every approval at or above the threshold with no click ("no human in the loop"). Or trigger a one-shot **Sweep Now**.
- **Explainable risk** — each approval shows the exact heuristic factors behind its score (unlimited approval, unverified source, contract age, unknown spender), and the analysis panel shows both the AI verdict and the heuristic breakdown.
- **Dollar-at-risk exposure** — every approval shows what it can drain *right now*: `min(wallet balance, allowance) × price` (prices via DefiLlama, no key; well-known Sepolia test tokens price as their mainnet asset). The list sorts by exposure by default, a header stat totals the wallet's $ at risk, and unknown balances/prices stay honest ("exposure ?") instead of fabricated. Exposure is also fed into the Venice analysis context.
- **Filter / sort / search** approvals (all · threats · unverified · max), clickable Etherscan links for every address and revocation tx, and one-click **kill-log export** to JSON.
- **Live rescan** — the scan loop re-reads on-chain allowances on a throttled cycle, plus a manual **Rescan** button.
- **Key custody controls** — Settings can wipe the locally-stored agent/sub-agent private keys.

## Delegation Caveats

The agent operates under strict constraints:

| Caveat | Root (Operator → Coordinator) | Child (Coordinator → Revoker) |
|--------|-------|-------|
| Scope | `functionCall`: `approve(address,uint256)`, value=0 | inherited from parent |
| Targets | the scanned ERC-20 contracts only | inherited from parent |
| Call limit | `limitedCalls(10)` | `limitedCalls(5)` (attenuated) |
| Expiry | `timestamp` — 30 days from grant | inherited from parent |

The delegation can be revoked at any time from the dashboard.

## x402 + ERC-7710 payments

The agent buys its own threat intelligence. Instead of a shared Venice API key,
each analysis is paid per-request via **x402** — a gasless USDC transfer on Base
(`venice-x402-client`). No account, no key, no human in the loop.

Spend is governed by an operator-signed **spend mandate** plus a client-side
cap. The operator signs a second ERC-7710 delegation
(`scope: erc20TransferAmount`) as a revocable, off-chain statement of intent —
"the agent may spend up to N USDC on inference." The agent self-enforces that
mandate before each call (`budget.spentUsd >= budget.capUsd`).

> **On-chain enforcement caveat.** The `ERC20TransferAmount` enforcer does **not**
> bound x402 spend on-chain, and the budget delegation is never redeemed. x402
> settles via the "exact" scheme — an ERC-3009 `transferWithAuthorization`
> signed by the agent EOA and submitted by Venice's facilitator. That direct
> USDC transfer never flows through the `DelegationManager`, so no caveat
> enforcer can observe or limit it. On-chain, the only hard bound is the agent
> wallet's funded USDC balance; the cap above is a client-side UX guard and a
> revocable off-chain mandate, not a trustless on-chain limit.

```
Operator (MetaMask Smart Account)
    │  createDelegation → erc20TransferAmount(USDC, max 1 USDC)
    │  = signed, revocable spend mandate (off-chain; NOT redeemed)
    ▼
Agent EOA  ──x402 (ERC-3009 transferWithAuthorization)──▶  Venice facilitator
    │  client-side cap check, then pay ~0.003 USDC per inference;
    │  facilitator submits the transfer on Base
    ▼
PhishingAnalysis
```

> Want a true on-chain cap? Fund the agent's x402 wallet with only the budget
> amount of USDC — ERC-3009 can't move more than the wallet holds.

Toggle x402 mode in Settings (or `VITE_X402_ENABLED=true`). When off, the app
uses a Venice API key instead. The agent's local smart-account key is the x402
payment wallet — fund it with USDC on Base (or Base Sepolia for testing).

## 1Shot relayer (gas in USDC, no ETH)

The revocation can be relayed through the **1Shot Permissionless Relayer** instead
of a Pimlico bundler. Toggle the relayer in Settings (Pimlico ↔ 1Shot). Requires
the delegation to be granted first (the relayed kill redeems the operator-rooted
chain). In 1Shot mode the kill is a gas-abstracted ERC-7710 bundle with two
redemptions:

1. **Upgrade** — the agent EOA is upgraded to a `7702StatelessDelegator` via an
   EIP-7702 `authorizationList` (signed locally, included on first relay).
2. **Fee delegation** — the agent signs a `functionCall`-scoped delegation to
   the relayer's `targetAddress` authorizing **only** the USDC fee `transfer`.
   The agent's wallet pays the gas fee in USDC.
3. **Revocation chain** — the Coordinator redelegates the operator-rooted
   delegation to the relayer's `targetAddress` as a single-use leaf
   (`limitedCalls(1)`, unique salt, signed locally — A2A). The relayer redeems
   `[coordinator→relayer, operator→coordinator]`, so `approve(spender, 0)`
   executes **from the operator smart account** — the actual approval owner —
   under all inherited caveats (functionCall scope, targets, expiry).
4. **Estimate** — `relayer_estimate7710Transaction` locks a gas-price quote and
   returns the exact USDC fee; the bundle is rebuilt + re-signed if the fee changes.
5. **Relay** — `relayer_send7710Transaction` submits the bundle; gas is paid in
   **USDC** (no ETH, no pre-funded paymaster). Returns a `TaskId`.
6. **Status** — `relayer_getStatus` is polled to terminal state. Set a
   `destinationUrl` in Settings to receive signed Ed25519 webhook events instead
   (verify against the relayer JWKS — recommended for production).

Endpoint is chosen by chain automatically: `relayer.1shotapi.dev` for Sepolia /
Base Sepolia, `relayer.1shotapi.com` for mainnets. No API key, no signup.

```
Agent EOA ──EIP-7702 upgrade──▶ 7702StatelessDelegator
    │  fee delegation (to: relayer.targetAddress, scope: functionCall[USDC.transfer])
    │
Coordinator ──redelegation (single-use leaf, A2A)──▶ relayer.targetAddress
    │  chain: [coordinator→relayer, operator→coordinator]
    ▼
1Shot relayer ──redeemDelegations──▶ approve(spender, 0)
    executes FROM the Operator smart account · gas paid in USDC by the agent
```

## Privacy

Venice AI's zero data retention policy means phishing screenshots and victim data are never stored or logged. This is critical for security operations — you can't ship sensitive threat intel to a logging AI provider.

## Deployment (GitHub Pages)

A workflow at [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
builds and publishes to GitHub Pages on every push to `main`.

1. Push this repo to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. Push to `main` (or run the workflow manually) → the site goes live at
   `https://<user>.github.io/<repo>/`.

The build is **keyless by default** — the published site ships no secrets and
runs in DEMO mode out of the box; visitors enable LIVE mode with their own keys
in Settings. To bake in live data without committing secrets, add repo
**Secrets** (`VITE_VENICE_API_KEY`, `VITE_ALCHEMY_API_KEY`,
`VITE_ETHERSCAN_API_KEY`, `VITE_INFURA_KEY`, `VITE_PIMLICO_API_KEY`) and/or a
**Variable** `VITE_PROXY_URL` pointing at the deployed [`worker/`](worker/)
proxy — the workflow reads them at build time. Prefer the proxy: a public URL
that keeps every key server-side (see [worker/README.md](worker/README.md)).

The Vite `base` is relative (`./`), so the build works under any Pages subpath
with no repo-name config.

## License

MIT


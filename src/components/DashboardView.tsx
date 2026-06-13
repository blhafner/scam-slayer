/**
 * DashboardView.tsx — main dashboard (moved out of App.tsx).
 *
 * Reads app state from the zustand store; keeps purely-presentational state
 * (filters, search, draft inputs) local.
 */

import { useState, useRef } from "react";
import type { TokenApproval } from "../lib/types";
import { useAppStore } from "../store/appStore";
import { shortenAddress } from "../lib/wallet";
import { CHAINS, explorerAddress, explorerTx } from "../lib/chains";
import { formatUsd } from "../lib/prices";
import { logColor } from "../styles";
import { RiskBar } from "./widgets";

// Dollar-at-risk badge: what min(balance, allowance) × price can drain today.
// Unknown stays honest ("exposure ?") instead of inventing a number.
function ExposureBadge({ a }: { a: TokenApproval }) {
  const usd = a.exposureUsd;
  const color =
    usd === null ? "#4a5568" : usd >= 1000 ? "#ff2d55" : usd >= 50 ? "#ffd60a" : usd > 0 ? "#c8ccd0" : "#4a5568";
  const label =
    usd === null
      ? "exposure ?"
      : usd === 0
      ? "$0 at risk (no balance)"
      : `${formatUsd(usd)} at risk`;
  const title =
    usd === null
      ? "Exposure unknown — balance or price could not be read"
      : `min(wallet balance, allowance) × price${
          a.exposureTokens !== null ? ` = ${a.exposureTokens.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${a.token}` : ""
        }${a.priceUsd !== null ? ` @ ${formatUsd(a.priceUsd)}` : ""}`;
  return (
    <span
      title={title}
      style={{
        fontSize: 10,
        fontWeight: 700,
        color,
        background: `${color}14`,
        border: `1px solid ${color}40`,
        borderRadius: 4,
        padding: "1px 8px",
        whiteSpace: "nowrap",
      }}
    >
      💰 {label}
    </span>
  );
}

export function DashboardView() {
  const store = useAppStore();
  const {
    eoaAddress, agentAddress, subAgentAddress, budget, config, demoMode,
    approvals, kills, delegationUsesLeft, scanProgress, agentActive,
    autoMode, autoThreshold, setAutoMode, setAutoThreshold, sweep, rescan, rescanning,
    selectedThreat, veniceResult, analysisModelLabel, analyzing, killAnimation,
    x402WalletAddress, x402BalanceUsd, x402CanConsume, x402MinimumTopUpUsd, x402StatusError,
    log, analyzeThreat, analyze, kill, createTestApproval, creatingApproval, clearSelection,
  } = store;

  const operatorAddress = store.operatorAddress ?? eoaAddress;
  const { x402Enabled, relayerMode } = config;
  const threats = approvals.filter((a) => a.riskScore > 75);
  const isLive = !!config.veniceApiKey || config.x402Enabled;
  // Smart-account delegation / A2A flow is Sepolia-only; other chains go straight
  // to the dashboard for scan + direct revocation.
  const chainSupportsDelegation = !!CHAINS[config.chainId]?.supportsSmartAccountDemo;
  const directRevokeOnly = !demoMode && !chainSupportsDelegation;
  const chainLabel = demoMode ? "Demo" : (CHAINS[config.chainId]?.label ?? "Unknown");

  const [url, setUrl] = useState("");
  const [copiedPayer, setCopiedPayer] = useState(false);
  const [testSpender, setTestSpender] = useState("0x6559779e81e8f08cE23767dc55BF22Fc5662DC37");
  const fileRef = useRef<HTMLInputElement>(null);

  // Approval list controls. Default sort: biggest dollar-at-risk first —
  // exposure is what an attacker can actually drain, risk score is the tiebreak.
  const [filter, setFilter] = useState<"all" | "threats" | "unverified" | "max">("all");
  const [sortBy, setSortBy] = useState<"exposure" | "risk" | "token">("exposure");
  const [query, setQuery] = useState("");

  const totalAtRiskUsd = approvals.reduce((sum, a) => sum + (a.exposureUsd ?? 0), 0);
  const hasAnyExposure = approvals.some((a) => a.exposureUsd !== null);

  const visibleApprovals = approvals
    .filter((a) => {
      if (filter === "threats" && a.riskScore <= 75) return false;
      if (filter === "unverified" && a.verified) return false;
      if (filter === "max" && !a.isMaxApproval) return false;
      if (query.trim()) {
        const q = query.trim().toLowerCase();
        if (
          !a.token.toLowerCase().includes(q) &&
          !a.spender.toLowerCase().includes(q) &&
          !(a.spenderLabel || "").toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    })
    .sort((a, b) =>
      sortBy === "exposure"
        ? (b.exposureUsd ?? -1) - (a.exposureUsd ?? -1) || b.riskScore - a.riskScore
        : sortBy === "risk"
        ? b.riskScore - a.riskScore
        : a.token.localeCompare(b.token)
    );

  const exportKills = () => {
    const blob = new Blob([JSON.stringify(kills, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `scam-slayer-kills-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(href);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => analyze({ imageBase64: reader.result as string, context: "Analyze this screenshot for phishing." });
    reader.readAsDataURL(file);
  };

  return (
    <div style={{ animation: "fadeIn 0.5s ease-out" }}>
      {/* Stats */}
      <div className="stats-grid" style={{ marginBottom: 24 }}>
        {[
          { label: "Active Approvals", value: approvals.length, color: "#c8ccd0" },
          {
            label: "$ At Risk",
            value: hasAnyExposure ? formatUsd(totalAtRiskUsd) : "—",
            color: totalAtRiskUsd > 0 ? "#ff2d55" : "#00ff9d",
          },
          { label: "Threats", value: threats.length, color: "#ff2d55" },
          { label: "Kills", value: kills.length, color: "#00ff9d" },
          { label: "Uses Left", value: `${delegationUsesLeft}/10`, color: "#ffd60a" },
        ].map((s, i) => (
          <div key={i} className="card" style={{ animation: `slideIn 0.3s ease-out ${i * 0.1}s both` }}>
            <div style={{ fontSize: 10, color: "#4a5568", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>{s.label}</div>
            <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 28, fontWeight: 700, color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* A2A delegation chain (Sepolia smart-account flow only) */}
      {!directRevokeOnly && (
      <div className="card" style={{ marginBottom: 16, borderColor: "#6366f140" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <span style={{ fontSize: 10, color: "#6366f1", letterSpacing: 1, textTransform: "uppercase", fontWeight: 600 }}>
            🤝 A2A Delegation Chain (ERC-7710 Redelegation)
          </span>
          <span className="tag" style={{ backgroundColor: relayerMode === "1shot" ? "#00ff9d20" : "#6366f120", color: relayerMode === "1shot" ? "#00ff9d" : "#6366f1" }}>
            ⛽ {relayerMode === "1shot" ? "1Shot · USDC gas + 7702" : "Pimlico · ETH gas"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {[
            { role: "Operator", addr: operatorAddress, sub: "MetaMask Smart Account", color: "#00ff9d" },
            { role: "Coordinator", addr: agentAddress, sub: "approve(addr,0) · 10 calls", color: "#6366f1" },
            { role: "Revoker", addr: subAgentAddress, sub: "redelegated · 5 calls", color: "#ffd60a" },
          ].map((n, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ background: "#0a0a14", border: `1px solid ${n.color}40`, borderRadius: 6, padding: "8px 12px", minWidth: 140 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: n.color }}>{n.role}</div>
                {n.addr ? (
                  <a href={explorerAddress(n.addr)} target="_blank" rel="noopener noreferrer" className="ext-link" style={{ fontSize: 10, fontFamily: "monospace" }} title={n.addr}>
                    {shortenAddress(n.addr)} ↗
                  </a>
                ) : (
                  <div style={{ fontSize: 10, color: "#c8ccd0", fontFamily: "monospace" }}>demo</div>
                )}
                <div style={{ fontSize: 9, color: "#4a5568" }}>{n.sub}</div>
              </div>
              {i < 2 && <span style={{ color: "#6366f1", fontSize: 16 }}>→</span>}
            </div>
          ))}
        </div>
      </div>
      )}

      {/* x402 intelligence budget (Sepolia smart-account flow only) */}
      {!directRevokeOnly && (
      <div className="card" style={{ marginBottom: 16, borderColor: "#ffd60a40" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 10, color: "#ffd60a", letterSpacing: 1, textTransform: "uppercase", fontWeight: 600 }}>
            💸 x402 Intelligence Budget {x402Enabled ? "(USDC on Base)" : "(client cap)"}
          </span>
          <span className="tag" style={{ backgroundColor: x402Enabled ? "#00ff9d20" : "#ffd60a20", color: x402Enabled ? "#00ff9d" : "#ffd60a" }}>
            {x402Enabled ? "x402 PAY-PER-CALL" : "API KEY"}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 11, color: "#c8ccd0" }}>
          <span>Operator → Agent spend mandate (client-enforced)</span>
          <span style={{ fontWeight: 600 }}>{budget.spentUsd.toFixed(4)} / {budget.capUsd.toFixed(2)} USDC</span>
        </div>
        {x402Enabled && x402WalletAddress && (
          <div style={{ marginBottom: 6, fontSize: 10, color: "#4a5568" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span>x402 payer wallet</span>
              <button
                className="btn btn-ghost"
                style={{ padding: "2px 8px", fontSize: 9 }}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(x402WalletAddress);
                    setCopiedPayer(true);
                    setTimeout(() => setCopiedPayer(false), 1200);
                  } catch {
                    /* clipboard might be unavailable in insecure context */
                  }
                }}
              >
                {copiedPayer ? "Copied" : "Copy"}
              </button>
            </div>
            <div style={{ color: "#c8ccd0", fontFamily: "monospace", wordBreak: "break-all", lineHeight: 1.5 }}>
              {x402WalletAddress}
            </div>
            {typeof x402BalanceUsd === "number" && (
              <div style={{ marginTop: 2, color: "#c8ccd0" }}>
                Balance: {x402BalanceUsd.toFixed(4)} USDC
              </div>
            )}
            {x402CanConsume === false && (
              <div style={{ marginTop: 2, color: "#ffd60a" }}>
                Spendable balance not ready. Venice currently reports minimum top-up {x402MinimumTopUpUsd ?? "?"} USDC.
              </div>
            )}
            {x402StatusError && (
              <div style={{ marginTop: 2, color: "#ff9aa2" }}>
                x402 status error: {x402StatusError}
              </div>
            )}
          </div>
        )}
        <div style={{ width: "100%", height: 4, backgroundColor: "#1a1a2e", borderRadius: 2, overflow: "hidden" }}>
          <div style={{ width: `${Math.min(100, (budget.spentUsd / budget.capUsd) * 100)}%`, height: "100%", backgroundColor: "#ffd60a", boxShadow: "0 0 8px #ffd60a60", transition: "width 0.6s ease-out" }} />
        </div>
      </div>
      )}

      {/* Autonomous Kill Mode */}
      <div className="card" style={{ marginBottom: 16, borderColor: autoMode ? "#ff2d5560" : "#1e1e3a" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#fff", marginBottom: 2 }}>
              🤖 Autonomous Kill Mode {autoMode && <span style={{ color: "#ff2d55" }}>· ARMED</span>}
            </div>
            <div style={{ fontSize: 10, color: "#4a5568", lineHeight: 1.6 }}>
              Agent auto-revokes approvals at or above the risk threshold — no human in the loop.
              {!demoMode && autoMode && <span style={{ color: "#ffd60a" }}> Executes real on-chain revocations.</span>}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 10, color: "#4a5568" }}>Threshold</span>
              <input
                type="range" min={40} max={100} step={1} value={autoThreshold}
                onChange={(e) => setAutoThreshold(Number(e.target.value))}
                style={{ accentColor: "#ff2d55", width: 100 }}
              />
              <span style={{ fontSize: 11, color: "#ff2d55", fontWeight: 600, minWidth: 26 }}>{autoThreshold}</span>
            </div>
            <button
              className="btn btn-ghost"
              style={{ padding: "6px 12px", fontSize: 10, color: autoMode ? "#ff2d55" : "#6b7280", borderColor: autoMode ? "#ff2d5540" : "#1e1e3a" }}
              onClick={() => setAutoMode(!autoMode)}
            >
              {autoMode ? "ARMED" : "ARM"}
            </button>
            <button
              className="btn btn-danger"
              style={{ padding: "6px 12px", fontSize: 10, whiteSpace: "nowrap" }}
              onClick={() => sweep({ manual: true })}
            >
              🤖 Sweep Now
            </button>
          </div>
        </div>
      </div>

      {/* Scan bar */}
      {agentActive && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: 10, color: "#4a5568", letterSpacing: 1, textTransform: "uppercase" }}>
              {rescanning ? "Rescanning on-chain..." : "Scanning..."}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 10, color: "#4a5568" }}>{Math.round(scanProgress)}%</span>
              <button
                className="btn btn-ghost"
                style={{ padding: "2px 10px", fontSize: 9 }}
                disabled={rescanning}
                onClick={() => rescan(false)}
              >
                {rescanning ? "..." : "🔄 Rescan"}
              </button>
            </div>
          </div>
          <div style={{ width: "100%", height: 2, backgroundColor: "#1e1e3a", borderRadius: 1, overflow: "hidden" }}>
            <div style={{ width: `${scanProgress}%`, height: "100%", background: "linear-gradient(90deg,#00ff9d,#00cc7d)", transition: "width 0.2s linear" }} />
          </div>
        </div>
      )}

      {/* Threat submission */}
      <div className="card" style={{ marginBottom: 16, borderColor: "#6366f140" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#fff", marginBottom: 12 }}>🔍 Submit Threat</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={url} onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste suspect URL or contract address..."
            className="text-input" style={{ flex: 1 }}
          />
          <button className="btn btn-ghost" style={{ padding: "6px 12px", fontSize: 10 }} onClick={() => fileRef.current?.click()}>
            📎
          </button>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleFileUpload} />
          <button
            className={`btn ${analyzing ? "btn-ghost" : "btn-primary"}`}
            style={{ padding: "6px 16px", fontSize: 10 }}
            disabled={analyzing || !url}
            onClick={() => { analyze({ context: `Analyze for phishing: ${url}` }); setUrl(""); }}
          >
            {analyzing ? "..." : "Analyze"}
          </button>
        </div>
      </div>

      {/* Test helper: create a smart-account-owned approval to demo autonomous revoke (Sepolia only) */}
      {!directRevokeOnly && (
      <div className="card" style={{ marginBottom: 16, borderColor: "#ffd60a40" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#fff", marginBottom: 4 }}>
          🧪 Create Test Approval (Smart Account)
        </div>
        <div style={{ fontSize: 10, color: "#4a5568", marginBottom: 12, lineHeight: 1.6 }}>
          Grants an unlimited USDC approval from your operator smart account to the spender below,
          so the agent can revoke it autonomously via the ERC-7710 chain. Requires the smart account
          to hold a little Sepolia ETH for gas.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={testSpender}
            onChange={(e) => setTestSpender(e.target.value)}
            placeholder="Spender address (e.g. your TestSpender contract)"
            className="text-input"
            style={{ flex: 1 }}
          />
          <button
            className={`btn ${creatingApproval ? "btn-ghost" : "btn-primary"}`}
            style={{ padding: "6px 16px", fontSize: 10, whiteSpace: "nowrap" }}
            disabled={creatingApproval || !testSpender}
            onClick={() => createTestApproval(testSpender)}
          >
            {creatingApproval ? "Creating..." : "Create Approval"}
          </button>
        </div>
      </div>
      )}

      {/* Two-col */}
      <div className="two-col">
        {/* Approvals */}
        <div className="card" style={{ animation: "glowPulse 3s ease-in-out infinite" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#fff" }}>
              Token Approvals
              <span style={{ fontSize: 10, color: "#6366f1", marginLeft: 8, fontWeight: 500 }}>· {chainLabel}</span>
            </span>
            <span className="tag" style={{ backgroundColor: threats.length ? "#ff2d5520" : "#00ff9d20", color: threats.length ? "#ff2d55" : "#00ff9d" }}>
              {threats.length} threat{threats.length !== 1 ? "s" : ""}
            </span>
          </div>
          {/* Controls */}
          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
            {([
              ["all", `All ${approvals.length}`],
              ["threats", "Threats"],
              ["unverified", "Unverified"],
              ["max", "Max"],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                className="btn btn-ghost"
                style={{
                  padding: "3px 10px",
                  fontSize: 9,
                  color: filter === key ? "#00ff9d" : "#6b7280",
                  borderColor: filter === key ? "#00ff9d40" : "#1e1e3a",
                }}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search token / spender..."
              className="text-input"
              style={{ flex: 1, minWidth: 120, padding: "4px 10px", fontSize: 10 }}
            />
            <button
              className="btn btn-ghost"
              style={{ padding: "3px 10px", fontSize: 9 }}
              onClick={() =>
                setSortBy((s) =>
                  s === "exposure" ? "risk" : s === "risk" ? "token" : "exposure"
                )
              }
            >
              Sort: {sortBy === "exposure" ? "$ at risk ↓" : sortBy === "risk" ? "Risk ↓" : "A→Z"}
            </button>
          </div>
          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            {visibleApprovals.map((a) => (
              <div
                key={a.id}
                className={killAnimation === a.id ? "kill-flash" : ""}
                style={{ padding: "12px 0", borderBottom: "1px solid #1e1e3a20", cursor: a.riskScore > 40 ? "pointer" : "default", opacity: killAnimation === a.id ? 0.5 : 1, transition: "opacity 0.3s" }}
                onClick={() => a.riskScore > 40 && analyzeThreat(a)}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 600, color: a.riskScore > 75 ? "#ff2d55" : a.riskScore > 40 ? "#ffd60a" : "#c8ccd0", fontSize: 12 }}>{a.token}</span>
                    {a.isMaxApproval && <span className="tag" style={{ backgroundColor: "#ff2d5520", color: "#ff2d55" }}>MAX</span>}
                    {!a.verified && <span className="tag" style={{ backgroundColor: "#ffd60a20", color: "#ffd60a" }}>UNVERIFIED</span>}
                    <span className="tag" style={{ backgroundColor: a.ownerType === "smart-account" ? "#6366f120" : "#4a556820", color: a.ownerType === "smart-account" ? "#6366f1" : "#6b7280" }}>
                      {a.ownerType === "smart-account" ? "SA · AGENT" : "EOA · DIRECT"}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <ExposureBadge a={a} />
                    <span style={{ fontSize: 11, color: "#4a5568" }}>Risk: {a.riskScore}</span>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "#4a5568", marginBottom: 6 }}>
                  →{" "}
                  <a
                    href={explorerAddress(a.spender)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ext-link"
                    onClick={(e) => e.stopPropagation()}
                    title={a.spender}
                  >
                    {a.spenderLabel || shortenAddress(a.spender)} ↗
                  </a>
                  {a.contractAge >= 0 && a.contractAge < 7 && <span style={{ color: "#ff2d55", marginLeft: 8 }}>({a.contractAge}d old)</span>}
                  {a.contractAge < 0 && <span style={{ color: "#4a5568", marginLeft: 8 }}>(age ?)</span>}
                </div>
                <RiskBar score={a.riskScore} />
                {a.riskScore > 40 && a.riskFactors?.length > 0 && (
                  <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {a.riskFactors.slice(0, 3).map((f, fi) => (
                      <span
                        key={fi}
                        style={{
                          fontSize: 9,
                          color: "#ff9aa2",
                          background: "#ff2d5512",
                          border: "1px solid #ff2d5520",
                          borderRadius: 4,
                          padding: "1px 6px",
                        }}
                      >
                        {f}
                      </span>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
                  {a.riskScore > 40 && (
                    <button
                      className="btn btn-ghost"
                      style={{ padding: "4px 10px", fontSize: 10 }}
                      onClick={(e) => { e.stopPropagation(); analyzeThreat(a); }}
                    >
                      Analyze
                    </button>
                  )}
                  <button
                    className="btn btn-danger"
                    style={{ padding: "4px 10px", fontSize: 10 }}
                    disabled={killAnimation === a.id}
                    onClick={(e) => { e.stopPropagation(); kill(a); }}
                  >
                    🗡️ Revoke
                  </button>
                </div>
              </div>
            ))}
            {visibleApprovals.length === 0 && (
              <div style={{ textAlign: "center", padding: 40, color: "#4a5568" }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>🛡️</div>
                {approvals.length === 0 ? "All clear" : "No approvals match this filter"}
              </div>
            )}
          </div>
        </div>

        {/* Right: Analysis or Kill Log */}
        {veniceResult || analyzing ? (
          <div className="card" style={{ borderColor: "#ff2d5540", animation: "fadeIn 0.3s ease-out" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#ff2d55" }}>🧠 Venice AI Analysis</span>
              <button className="btn btn-ghost" style={{ padding: "2px 8px", fontSize: 10 }} onClick={clearSelection}>✕</button>
            </div>
            {analyzing ? (
              <div style={{ textAlign: "center", padding: 40 }}>
                <div style={{ fontSize: 32, marginBottom: 12, animation: "pulse 1s ease-in-out infinite" }}>🧠</div>
                <div style={{ color: "#6366f1", fontSize: 12 }}>Analyzing with {analysisModelLabel || (isLive ? "live model" : "demo engine")}...</div>
                <div style={{ color: "#4a5568", fontSize: 10, marginTop: 4 }}>Zero data retention</div>
              </div>
            ) : veniceResult && (
              <>
                <div className="caveat-box" style={{ marginBottom: 16 }}>
                  {[
                    { l: "Model", v: analysisModelLabel || (isLive ? "live model" : "demo"), c: "#6366f1" },
                    { l: "Verdict", v: veniceResult.is_phishing ? `PHISHING — ${veniceResult.confidence}%` : `CLEAN — ${veniceResult.confidence}%`, c: veniceResult.is_phishing ? "#ff2d55" : "#00ff9d" },
                    veniceResult.brand_impersonated ? { l: "Impersonating", v: veniceResult.brand_impersonated, c: "#ffd60a" } : null,
                    { l: "Privacy", v: "Zero retention ✓", c: "#00ff9d" },
                  ].filter(Boolean).map((r: any, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                      <span style={{ fontSize: 10, color: "#4a5568" }}>{r.l}</span>
                      <span style={{ fontSize: 10, color: r.c, fontWeight: 600 }}>{r.v}</span>
                    </div>
                  ))}
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 10, color: "#4a5568", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>Indicators</div>
                  {veniceResult.indicators?.map((ind, i) => (
                    <div key={i} style={{ fontSize: 11, color: "#c8ccd0", padding: "3px 0", display: "flex", gap: 8, animation: `slideIn 0.3s ease-out ${i * 0.08}s both` }}>
                      <span style={{ color: "#ff2d55" }}>▸</span>{ind}
                    </div>
                  ))}
                </div>
                {selectedThreat?.riskFactors?.length ? (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 10, color: "#4a5568", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>
                      Heuristic Risk Factors ({selectedThreat.riskScore}/100)
                    </div>
                    {selectedThreat.riskFactors.map((f, i) => (
                      <div key={i} style={{ fontSize: 11, color: "#ffd60a", padding: "3px 0", display: "flex", gap: 8 }}>
                        <span style={{ color: "#ffd60a" }}>⚠</span>{f}
                      </div>
                    ))}
                  </div>
                ) : null}
                <div style={{ background: "#0a0a14", borderRadius: 6, padding: 12, marginBottom: 16, border: "1px solid #1e1e3a", fontSize: 11, color: "#6b7280", lineHeight: 1.8, fontStyle: "italic" }}>
                  "{veniceResult.reasoning}"
                </div>
                {selectedThreat && (
                  <button
                    className="btn btn-danger"
                    style={{ width: "100%", padding: 12, fontSize: 13 }}
                    onClick={() => kill(selectedThreat)}
                  >
                    {veniceResult.is_phishing
                      ? "🗡️ EXECUTE KILL — Revoke via Delegation"
                      : "🗡️ Revoke Approval via Delegation"}
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#fff" }}>Kill Log</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {kills.length > 0 && (
                  <button className="btn btn-ghost" style={{ padding: "2px 8px", fontSize: 9 }} onClick={exportKills}>
                    ⬇ Export
                  </button>
                )}
                <span className="tag" style={{ backgroundColor: "#00ff9d20", color: "#00ff9d" }}>{kills.length}</span>
              </div>
            </div>
            <div style={{ maxHeight: 360, overflowY: "auto" }}>
              {kills.map((k, i) => (
                <div key={k.id} style={{ padding: "12px 0", borderBottom: "1px solid #1e1e3a20", animation: `slideIn 0.3s ease-out ${i * 0.05}s both` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#00ff9d" }}>🗡️ {k.token}</span>
                    <span style={{ fontSize: 10, color: "#4a5568" }}>{new Date(k.timestamp).toLocaleDateString()}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "#c8ccd0", marginBottom: 4 }}>{k.threat}</div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 10, color: "#4a5568" }}>Confidence: {k.confidence}%</span>
                    {k.txHash ? (
                      <a href={explorerTx(k.txHash)} target="_blank" rel="noopener noreferrer" className="ext-link" style={{ fontSize: 10 }}>
                        tx: {shortenAddress(k.txHash)} ↗
                      </a>
                    ) : (
                      <span style={{ fontSize: 10, color: "#6366f1" }}>tx: pending</span>
                    )}
                  </div>
                </div>
              ))}
              {kills.length === 0 && (
                <div style={{ textAlign: "center", padding: 40, color: "#4a5568", fontSize: 11 }}>
                  No kills yet. Click a threat to analyze.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Log */}
      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#fff", marginBottom: 12 }}>Agent Log</div>
        <div style={{ maxHeight: 140, overflowY: "auto", fontSize: 10, lineHeight: 2 }}>
          {log.length === 0 ? (
            <div style={{ color: "#4a5568" }}>Awaiting activity...</div>
          ) : log.map((entry, i) => (
            <div key={i} style={{ color: logColor(entry), animation: i === 0 ? "slideIn 0.2s ease-out" : "none" }}>
              <span style={{ color: "#2a2a50", marginRight: 8 }}>{entry.time}</span>{entry.msg}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

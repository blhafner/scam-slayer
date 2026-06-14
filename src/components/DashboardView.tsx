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
import { RiskBar, riskLabel, InfoDot, Collapsible, Pulse } from "./widgets";

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
    approvals, kills, delegationUsesLeft,
    autoMode, autoThreshold, setAutoMode, setAutoThreshold, sweep, rescan, rescanning,
    selectedThreat, veniceResult, analysisModelLabel, analyzing, killAnimation,
    x402WalletAddress, x402BalanceUsd, x402CanConsume, x402MinimumTopUpUsd, x402StatusError,
    log, analyzeThreat, analyze, kill, createTestApproval, creatingApproval, clearSelection,
    seedMaliciousApprovals, seeding,
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

  const riskyCount = threats.length;

  return (
    <div style={{ animation: "fadeIn 0.5s ease-out" }}>
      {/* Plain-language summary: what's happening, in one sentence. */}
      <div className="card" style={{ marginBottom: 16, borderColor: riskyCount ? "#ff2d5540" : "#1e1e3a" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#fff", marginBottom: 4, fontFamily: "'Space Grotesk',sans-serif" }}>
              {demoMode
                ? "Demo — showing example approvals"
                : riskyCount > 0
                ? `${riskyCount} risky approval${riskyCount !== 1 ? "s" : ""} on ${chainLabel}`
                : approvals.length > 0
                ? `Monitoring ${approvals.length} approval${approvals.length !== 1 ? "s" : ""} on ${chainLabel}`
                : `No approvals found on ${chainLabel}`}
            </div>
            <div style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.6, maxWidth: 620 }}>
              A token approval lets a contract move your tokens. Scammers trick you into unlimited
              approvals, then drain your wallet. Scam Slayer finds the dangerous ones — sorted by how
              much they could drain right now — and revokes them in one click.
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10, color: "#4a5568", display: "flex", alignItems: "center", gap: 5 }}>
              <Pulse color={rescanning ? "#ffd60a" : "#00ff9d"} size={6} />
              {rescanning ? "Rescanning…" : "Monitoring live"}
            </span>
            <button
              className="btn btn-ghost"
              style={{ padding: "4px 12px", fontSize: 10 }}
              disabled={rescanning}
              onClick={() => rescan(false)}
            >
              {rescanning ? "…" : "🔄 Rescan"}
            </button>
          </div>
        </div>
      </div>

      {/* Stats — value-first ordering: dollars at risk and risky count lead. */}
      <div className="stats-grid" style={{ marginBottom: 24 }}>
        {[
          {
            label: "Total at risk",
            value: hasAnyExposure ? formatUsd(totalAtRiskUsd) : "—",
            color: totalAtRiskUsd > 0 ? "#ff2d55" : "#00ff9d",
            info: "Sum of what every approval could drain right now: min(balance, allowance) × price.",
          },
          { label: "Risky approvals", value: riskyCount, color: riskyCount ? "#ff2d55" : "#00ff9d", info: "Approvals scored High or Critical risk." },
          { label: "Active approvals", value: approvals.length, color: "#c8ccd0", info: "Total token permissions this wallet has granted." },
          { label: "Revoked", value: kills.length, color: "#00ff9d", info: "Approvals you've killed this session." },
          { label: "Revokes left", value: `${delegationUsesLeft}/10`, color: "#ffd60a", info: "Remaining autonomous revocations allowed by the agent's permission." },
        ].map((s, i) => (
          <div key={i} className="card" style={{ animation: `slideIn 0.3s ease-out ${i * 0.08}s both` }}>
            <div style={{ fontSize: 10, color: "#4a5568", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
              {s.label}<InfoDot text={s.info} />
            </div>
            <div style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 26, fontWeight: 700, color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* PRIMARY: approvals (the product) + analysis / kill log */}
      <div className="two-col">
        {/* Approvals */}
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>Your token approvals</span>
            <span className="tag" style={{ backgroundColor: riskyCount ? "#ff2d5520" : "#00ff9d20", color: riskyCount ? "#ff2d55" : "#00ff9d" }}>
              {riskyCount ? `${riskyCount} risky` : "all clear"}
            </span>
          </div>
          <div style={{ fontSize: 10, color: "#4a5568", marginBottom: 12 }}>
            Permissions you've granted to move your tokens · {chainLabel}. Click any row for AI analysis.
          </div>
          {/* Controls */}
          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
            {([
              ["all", `All ${approvals.length}`],
              ["threats", "Risky"],
              ["unverified", "Unverified"],
              ["max", "Unlimited"],
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
          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            {visibleApprovals.map((a) => {
              const rl = riskLabel(a.riskScore);
              return (
              <div
                key={a.id}
                className={killAnimation === a.id ? "kill-flash" : ""}
                style={{ padding: "12px 0", borderBottom: "1px solid #1e1e3a20", cursor: a.riskScore > 40 ? "pointer" : "default", opacity: killAnimation === a.id ? 0.5 : 1, transition: "opacity 0.3s" }}
                onClick={() => a.riskScore > 40 && analyzeThreat(a)}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 600, color: rl.color, fontSize: 13 }}>{a.token}</span>
                    {a.isMaxApproval && <span className="tag" style={{ backgroundColor: "#ff2d5520", color: "#ff2d55" }}>UNLIMITED</span>}
                    {!a.verified && <span className="tag" style={{ backgroundColor: "#ffd60a20", color: "#ffd60a" }}>UNVERIFIED</span>}
                    <span className="tag" style={{ backgroundColor: a.ownerType === "smart-account" ? "#6366f120" : "#4a556820", color: a.ownerType === "smart-account" ? "#6366f1" : "#9aa0a6" }}>
                      {a.ownerType === "smart-account" ? "Smart account" : "Your wallet"}
                    </span>
                  </div>
                  <ExposureBadge a={a} />
                </div>
                <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 8 }}>
                  Granted to{" "}
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
                  {a.contractAge >= 0 && a.contractAge < 7 && <span style={{ color: "#ff2d55", marginLeft: 8 }}>· deployed {a.contractAge}d ago</span>}
                  {a.contractAge < 0 && <span style={{ color: "#4a5568", marginLeft: 8 }}>· age unknown</span>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: rl.color, minWidth: 56 }}>{rl.label} risk</span>
                  <div style={{ flex: 1 }}><RiskBar score={a.riskScore} /></div>
                  <span style={{ fontSize: 10, color: "#4a5568", minWidth: 28, textAlign: "right" }}>{a.riskScore}</span>
                </div>
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
                      Analyze with AI
                    </button>
                  )}
                  <button
                    className="btn btn-danger"
                    style={{ padding: "4px 12px", fontSize: 10 }}
                    disabled={killAnimation === a.id}
                    onClick={(e) => { e.stopPropagation(); kill(a); }}
                  >
                    {killAnimation === a.id ? "Revoking…" : "Revoke"}
                  </button>
                </div>
              </div>
              );
            })}
            {visibleApprovals.length === 0 && (
              <div style={{ textAlign: "center", padding: 40, color: "#6b7280" }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>🛡️</div>
                {approvals.length === 0 ? (
                  <>
                    <div style={{ color: "#c8ccd0", marginBottom: 4 }}>No active approvals found.</div>
                    <div style={{ fontSize: 11 }}>This wallet hasn't granted any token permissions on {chainLabel} — or the scan couldn't reach an RPC. Try Rescan, or add an Alchemy key in Settings.</div>
                  </>
                ) : (
                  "No approvals match this filter."
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right: Analysis or Kill Log */}
        {veniceResult || analyzing ? (
          <div className="card" style={{ borderColor: "#ff2d5540", animation: "fadeIn 0.3s ease-out" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#ff2d55" }}>AI threat analysis</span>
              <button className="btn btn-ghost" style={{ padding: "2px 8px", fontSize: 10 }} onClick={clearSelection}>✕</button>
            </div>
            {analyzing ? (
              <div style={{ textAlign: "center", padding: 40 }}>
                <div style={{ fontSize: 32, marginBottom: 12, animation: "pulse 1s ease-in-out infinite" }}>🧠</div>
                <div style={{ color: "#6366f1", fontSize: 12 }}>Analyzing…</div>
                <div style={{ color: "#4a5568", fontSize: 10, marginTop: 4 }}>{analysisModelLabel || (isLive ? "live model" : "demo engine")} · zero data retention</div>
              </div>
            ) : veniceResult && (
              <>
                <div className="caveat-box" style={{ marginBottom: 16 }}>
                  {[
                    { l: "Verdict", v: veniceResult.is_phishing ? `Phishing — ${veniceResult.confidence}% sure` : `Looks clean — ${veniceResult.confidence}%`, c: veniceResult.is_phishing ? "#ff2d55" : "#00ff9d" },
                    veniceResult.brand_impersonated ? { l: "Impersonating", v: veniceResult.brand_impersonated, c: "#ffd60a" } : null,
                    { l: "Model", v: analysisModelLabel || (isLive ? "live model" : "demo"), c: "#6366f1" },
                    { l: "Privacy", v: "Zero retention ✓", c: "#00ff9d" },
                  ].filter(Boolean).map((r: any, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                      <span style={{ fontSize: 10, color: "#4a5568" }}>{r.l}</span>
                      <span style={{ fontSize: 10, color: r.c, fontWeight: 600 }}>{r.v}</span>
                    </div>
                  ))}
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 10, color: "#4a5568", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>What the AI saw</div>
                  {veniceResult.indicators?.map((ind, i) => (
                    <div key={i} style={{ fontSize: 11, color: "#c8ccd0", padding: "3px 0", display: "flex", gap: 8 }}>
                      <span style={{ color: "#ff2d55" }}>▸</span>{ind}
                    </div>
                  ))}
                </div>
                {selectedThreat?.riskFactors?.length ? (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 10, color: "#4a5568", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>
                      Why it's risky ({riskLabel(selectedThreat.riskScore).label}, {selectedThreat.riskScore}/100)
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
                    Revoke this {selectedThreat.token} approval
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>Revoked approvals</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {kills.length > 0 && (
                  <button className="btn btn-ghost" style={{ padding: "2px 8px", fontSize: 9 }} onClick={exportKills}>
                    ⬇ Export
                  </button>
                )}
                <span className="tag" style={{ backgroundColor: "#00ff9d20", color: "#00ff9d" }}>{kills.length}</span>
              </div>
            </div>
            <div style={{ fontSize: 10, color: "#4a5568", marginBottom: 12 }}>Approvals killed this session, with on-chain proof.</div>
            <div style={{ maxHeight: 420, overflowY: "auto" }}>
              {kills.map((k, i) => (
                <div key={k.id} style={{ padding: "12px 0", borderBottom: "1px solid #1e1e3a20", animation: `slideIn 0.3s ease-out ${i * 0.05}s both` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "#00ff9d" }}>✓ {k.token} revoked</span>
                    <span style={{ fontSize: 10, color: "#4a5568" }}>{new Date(k.timestamp).toLocaleDateString()}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "#c8ccd0", marginBottom: 4 }}>{k.threat}</div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 10, color: "#4a5568" }}>AI confidence: {k.confidence}%</span>
                    {k.txHash ? (
                      <a href={explorerTx(k.txHash)} target="_blank" rel="noopener noreferrer" className="ext-link" style={{ fontSize: 10 }}>
                        view tx ↗
                      </a>
                    ) : (
                      <span style={{ fontSize: 10, color: "#6366f1" }}>tx: pending</span>
                    )}
                  </div>
                </div>
              ))}
              {kills.length === 0 && (
                <div style={{ textAlign: "center", padding: 40, color: "#6b7280", fontSize: 11 }}>
                  Nothing revoked yet. Click a risky approval to analyze, then Revoke.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Autonomous mode — power feature, below the primary flow */}
      <div className="card" style={{ marginTop: 16, marginBottom: 16, borderColor: autoMode ? "#ff2d5560" : "#1e1e3a" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#fff", marginBottom: 2 }}>
              🤖 Auto-revoke {autoMode && <span style={{ color: "#ff2d55" }}>· ON</span>}
            </div>
            <div style={{ fontSize: 10, color: "#6b7280", lineHeight: 1.6, maxWidth: 460 }}>
              Automatically revoke approvals at or above the risk threshold — no clicking.
              {!demoMode && autoMode && <span style={{ color: "#ffd60a" }}> Executes real on-chain revocations.</span>}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 10, color: "#4a5568" }}>Revoke at risk ≥</span>
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
              {autoMode ? "Turn off" : "Turn on"}
            </button>
            <button
              className="btn btn-danger"
              style={{ padding: "6px 12px", fontSize: 10, whiteSpace: "nowrap" }}
              onClick={() => sweep({ manual: true })}
            >
              Revoke all risky now
            </button>
          </div>
        </div>
      </div>

      {/* Advanced: the agent + payment internals, demoted (Sepolia smart-account flow only) */}
      {!directRevokeOnly && (
        <Collapsible
          title="Under the hood · agent permission & payments"
          subtitle="How the agent is authorized to revoke, and how it pays for AI analysis"
          badge={relayerMode === "1shot" ? "1Shot · USDC gas" : "Pimlico · ETH gas"}
          accent="#6366f1"
        >
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, color: "#6366f1", letterSpacing: 1, textTransform: "uppercase", fontWeight: 600, marginBottom: 8 }}>
              Permission chain (ERC-7710 delegation)
              <InfoDot text="Your smart account grants a revoke-only permission to a Coordinator agent, which passes a tighter version to a Revoker. The agent can ONLY call approve(x,0) — it can never move funds." />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {[
                { role: "You (operator)", addr: operatorAddress, sub: "your smart account", color: "#00ff9d" },
                { role: "Coordinator", addr: agentAddress, sub: "revoke-only · 10 uses", color: "#6366f1" },
                { role: "Revoker", addr: subAgentAddress, sub: "executes the kill · 5 uses", color: "#ffd60a" },
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

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 10, color: "#ffd60a", letterSpacing: 1, textTransform: "uppercase", fontWeight: 600 }}>
                AI analysis budget
                <InfoDot text="The agent pays per AI analysis. With x402 on, it pays in USDC on Base (no API key); otherwise a shared API key is used. Spend is capped." />
              </span>
              <span className="tag" style={{ backgroundColor: x402Enabled ? "#00ff9d20" : "#ffd60a20", color: x402Enabled ? "#00ff9d" : "#ffd60a" }}>
                {x402Enabled ? "x402 pay-per-call" : "API key"}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 11, color: "#c8ccd0" }}>
              <span>Spent / cap</span>
              <span style={{ fontWeight: 600 }}>{budget.spentUsd.toFixed(4)} / {budget.capUsd.toFixed(2)} USDC</span>
            </div>
            <div style={{ width: "100%", height: 4, backgroundColor: "#1a1a2e", borderRadius: 2, overflow: "hidden", marginBottom: 6 }}>
              <div style={{ width: `${Math.min(100, (budget.spentUsd / budget.capUsd) * 100)}%`, height: "100%", backgroundColor: "#ffd60a", transition: "width 0.6s ease-out" }} />
            </div>
            {x402Enabled && x402WalletAddress && (
              <div style={{ fontSize: 10, color: "#4a5568" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span>Payer wallet (fund with USDC on Base)</span>
                  <button
                    className="btn btn-ghost"
                    style={{ padding: "2px 8px", fontSize: 9 }}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(x402WalletAddress);
                        setCopiedPayer(true);
                        setTimeout(() => setCopiedPayer(false), 1200);
                      } catch {
                        /* clipboard unavailable in insecure context */
                      }
                    }}
                  >
                    {copiedPayer ? "Copied" : "Copy"}
                  </button>
                </div>
                <div style={{ color: "#c8ccd0", fontFamily: "monospace", wordBreak: "break-all", lineHeight: 1.5 }}>{x402WalletAddress}</div>
                {typeof x402BalanceUsd === "number" && <div style={{ marginTop: 2, color: "#c8ccd0" }}>Balance: {x402BalanceUsd.toFixed(4)} USDC</div>}
                {x402CanConsume === false && <div style={{ marginTop: 2, color: "#ffd60a" }}>Needs a top-up of at least {x402MinimumTopUpUsd ?? "?"} USDC.</div>}
                {x402StatusError && <div style={{ marginTop: 2, color: "#ff9aa2" }}>{x402StatusError}</div>}
              </div>
            )}
          </div>
        </Collapsible>
      )}

      {/* Testing & manual tools — collapsed by default */}
      <Collapsible
        title="Testing & manual tools"
        subtitle="Check a URL or contract by hand, or create test approvals to try the flow"
        accent="#6b7280"
      >
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#fff", marginBottom: 8 }}>Check a URL or contract</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste a suspect URL or contract address…"
              className="text-input" style={{ flex: 1 }}
            />
            <button className="btn btn-ghost" style={{ padding: "6px 12px", fontSize: 10 }} title="Upload a screenshot" onClick={() => fileRef.current?.click()}>
              📎
            </button>
            <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleFileUpload} />
            <button
              className={`btn ${analyzing ? "btn-ghost" : "btn-primary"}`}
              style={{ padding: "6px 16px", fontSize: 10 }}
              disabled={analyzing || !url}
              onClick={() => { analyze({ context: `Analyze for phishing: ${url}` }); setUrl(""); }}
            >
              {analyzing ? "…" : "Analyze"}
            </button>
          </div>
        </div>

        {!directRevokeOnly && (
          <div style={{ paddingTop: 16, borderTop: "1px solid #1e1e3a" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#fff", marginBottom: 4 }}>Create a test approval (smart account)</div>
            <div style={{ fontSize: 10, color: "#4a5568", marginBottom: 10, lineHeight: 1.6 }}>
              Grants an unlimited USDC approval from your smart account so the agent can revoke it autonomously. Needs a little Sepolia ETH.
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input
                value={testSpender}
                onChange={(e) => setTestSpender(e.target.value)}
                placeholder="Spender address"
                className="text-input"
                style={{ flex: 1 }}
              />
              <button
                className={`btn ${creatingApproval ? "btn-ghost" : "btn-primary"}`}
                style={{ padding: "6px 16px", fontSize: 10, whiteSpace: "nowrap" }}
                disabled={creatingApproval || !testSpender}
                onClick={() => createTestApproval(testSpender)}
              >
                {creatingApproval ? "Creating…" : "Create approval"}
              </button>
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#ff9aa2", marginBottom: 4 }}>Seed malicious approvals (your wallet)</div>
            <div style={{ fontSize: 10, color: "#4a5568", marginBottom: 10, lineHeight: 1.6 }}>
              Deploys a fresh unverified spender and grants unlimited USDC / WETH / LINK approvals to it from your wallet — real, directly-revocable threats to demo the kill flow. One signature per step; needs a little Sepolia ETH.
            </div>
            <button
              className={`btn ${seeding ? "btn-ghost" : "btn-danger"}`}
              style={{ padding: "8px 16px", fontSize: 10, width: "100%" }}
              disabled={seeding}
              onClick={() => seedMaliciousApprovals()}
            >
              {seeding ? "Seeding…" : "🩸 Seed malicious approvals on Sepolia"}
            </button>
          </div>
        )}
      </Collapsible>

      {/* Activity log — collapsed by default */}
      <Collapsible title="Activity log" subtitle="What the agent has done this session" accent="#6b7280">
        <div style={{ maxHeight: 200, overflowY: "auto", fontSize: 10, lineHeight: 2 }}>
          {log.length === 0 ? (
            <div style={{ color: "#4a5568" }}>Nothing yet.</div>
          ) : log.map((entry, i) => (
            <div key={i} style={{ color: logColor(entry) }}>
              <span style={{ color: "#2a2a50", marginRight: 8 }}>{entry.time}</span>{entry.msg}
            </div>
          ))}
        </div>
      </Collapsible>
    </div>
  );
}

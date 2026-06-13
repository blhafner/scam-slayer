/**
 * LandingView.tsx — pre-connect landing page (moved out of App.tsx).
 */

import { useAppStore } from "../store/appStore";

export function LandingView() {
  const connect = useAppStore((s) => s.connect);
  const enterDemo = useAppStore((s) => s.enterDemo);
  const connectionError = useAppStore((s) => s.connectionError);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "70vh", textAlign: "center", animation: "fadeIn 0.5s ease-out" }}>
      <div style={{ fontSize: 64, marginBottom: 24 }}>🗡️</div>
      <h1 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 36, fontWeight: 700, color: "#fff", marginBottom: 8, letterSpacing: -1 }}>
        Your wallet has a bodyguard now.
      </h1>
      <p style={{ color: "#6b7280", maxWidth: 480, marginBottom: 32, lineHeight: 1.8 }}>
        Scam Slayer monitors your token approvals, classifies threats with AI vision, and auto-revokes malicious permissions — all within a scoped delegation you control.
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
        <button className="btn btn-primary" style={{ padding: "12px 32px", fontSize: 14 }} onClick={connect}>
          Connect MetaMask
        </button>
        <button className="btn btn-ghost" style={{ padding: "12px 28px", fontSize: 14 }} onClick={enterDemo}>
          ▶ Explore Demo
        </button>
      </div>
      <div style={{ marginTop: 12, fontSize: 11, color: "#4a5568" }}>
        No wallet? <span style={{ color: "#00ff9d" }}>Explore Demo</span> runs the full flow with mock data — zero setup.
      </div>
      {connectionError && (
        <div
          style={{
            marginTop: 12,
            maxWidth: 560,
            fontSize: 11,
            color: "#ff9aa2",
            lineHeight: 1.6,
          }}
        >
          Wallet connection error: {connectionError}
        </div>
      )}
      <div style={{ marginTop: 48, display: "flex", gap: 48 }}>
        {[
          { icon: "🔍", label: "Scan", desc: "Monitor active approvals" },
          { icon: "🧠", label: "Analyze", desc: "Venice AI phishing detection" },
          { icon: "🗡️", label: "Kill", desc: "Auto-revoke threats" },
        ].map((s, i) => (
          <div key={i} style={{ textAlign: "center" }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>{s.icon}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#00ff9d", marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontSize: 11, color: "#4a5568" }}>{s.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * DelegationView.tsx — delegation grant screen (moved out of App.tsx).
 */

import { useAppStore } from "../store/appStore";

export function DelegationView() {
  const grantDelegation = useAppStore((s) => s.grantDelegation);
  const delegationError = useAppStore((s) => s.delegationError);

  return (
    <div style={{ maxWidth: 560, margin: "60px auto", animation: "fadeIn 0.5s ease-out" }}>
      <div className="card" style={{ padding: 32 }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🛡️</div>
          <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 8 }}>
            Grant Agent Delegation
          </h2>
          <p style={{ color: "#6b7280", fontSize: 12 }}>
            Your smart account delegates a scoped ERC-7710 permission to a Coordinator agent, which re-delegates an attenuated permission to a Revoker sub-agent (A2A). Agents can ONLY revoke approvals — never spend or transfer.
          </p>
        </div>
        <div className="caveat-box">
          <div style={{ fontSize: 10, color: "#00ff9d", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12, fontWeight: 600 }}>
            Delegation Caveats (ERC-7710)
          </div>
          {[
            ["Allowed Methods", "approve(address, 0) only"],
            ["Scope", "Revoke approvals — no transfers"],
            ["Rate Limit", "10 revocations / day"],
            ["Expiry", "30 days from grant"],
            ["Targets", "ERC-20 contracts only"],
          ].map(([label, value], i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: i < 4 ? "1px solid #1e1e3a20" : "none" }}>
              <span style={{ color: "#6b7280", fontSize: 11 }}>{label}</span>
              <span style={{ color: "#c8ccd0", fontSize: 11, fontWeight: 500 }}>{value}</span>
            </div>
          ))}
        </div>
        <div className="code-preview" style={{ marginBottom: 20 }}>
          <div style={{ color: "#4a5568" }}>{"// @metamask/smart-accounts-kit — A2A redelegation"}</div>
          <div><span className="kw">const</span> root = createDelegation({"{"}</div>
          <div className="indent">environment, from: operator, to: coordinator,</div>
          <div className="indent">scope: {"{"} type: <span className="str">"functionCall"</span>,</div>
          <div className="indent2">selectors: [<span className="str">"approve(address,uint256)"</span>] {"}"},</div>
          <div className="indent">caveats: [limitedCalls(<span className="num">10</span>), timestamp(<span className="num">30d</span>)],</div>
          <div>{"}"});</div>
          <div><span className="kw">const</span> child = createDelegation({"{"}</div>
          <div className="indent">from: coordinator, to: revoker,</div>
          <div className="indent">parentDelegation: root, <span style={{ color: "#4a5568" }}>{"// links chain"}</span></div>
          <div className="indent">caveats: [limitedCalls(<span className="num">5</span>)],</div>
          <div>{"}"});</div>
        </div>
        <div className="warn-box">
          <span style={{ color: "#ffd60a" }}>⚠️</span> One MetaMask signature grants the revoke-only delegation above. It moves no funds and is revocable at any time. The agent key is generated locally. (A second signature appears only if x402 paid inference is enabled — a separate USDC spend cap.)
        </div>
        {delegationError && (
          <div
            style={{
              marginTop: 12,
              padding: 10,
              borderRadius: 6,
              border: "1px solid #ff2d5540",
              background: "#2a0f1820",
              color: "#ff9aa2",
              fontSize: 11,
              lineHeight: 1.6,
            }}
          >
            Delegation failed: {delegationError}
          </div>
        )}
        <button className="btn btn-primary" style={{ width: "100%", padding: 12, fontSize: 13, marginTop: 16 }} onClick={grantDelegation}>
          Sign Delegation with MetaMask
        </button>
      </div>
    </div>
  );
}

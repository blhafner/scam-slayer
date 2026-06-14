/**
 * DelegationView.tsx — delegation grant screen (plain-language).
 * Leads with what the user is actually agreeing to; the ERC-7710 details sit in
 * a collapsed "technical details" section.
 */

import { useAppStore } from "../store/appStore";
import { Collapsible } from "./widgets";

export function DelegationView() {
  const grantDelegation = useAppStore((s) => s.grantDelegation);
  const delegationError = useAppStore((s) => s.delegationError);

  return (
    <div style={{ maxWidth: 560, margin: "60px auto", animation: "fadeIn 0.5s ease-out" }}>
      <div className="card" style={{ padding: 32 }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🛡️</div>
          <h2 style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 22, fontWeight: 700, color: "#fff", marginBottom: 8 }}>
            Let the agent revoke for you
          </h2>
          <p style={{ color: "#9aa0a6", fontSize: 13, lineHeight: 1.7 }}>
            One signature gives Scam Slayer a <strong style={{ color: "#fff" }}>revoke-only</strong> permission,
            so it can cancel dangerous approvals on your behalf — even automatically. It
            <strong style={{ color: "#00ff9d" }}> can never move, spend, or transfer your funds.</strong>
          </p>
        </div>

        {/* Plain "what you're allowing" list */}
        <div className="caveat-box">
          <div style={{ fontSize: 10, color: "#00ff9d", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12, fontWeight: 600 }}>
            What this permission allows
          </div>
          {[
            ["✓ Can do", "Cancel token approvals (set them to zero)", "#00ff9d"],
            ["✗ Cannot do", "Move, spend, or transfer any of your tokens", "#ff2d55"],
            ["Limit", "Up to 10 revocations total", "#c8ccd0"],
            ["Expires", "Automatically after 30 days", "#c8ccd0"],
            ["Revocable", "Cancel the permission anytime", "#c8ccd0"],
          ].map(([label, value, color], i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "7px 0", borderBottom: i < 4 ? "1px solid #1e1e3a20" : "none" }}>
              <span style={{ color, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>{label}</span>
              <span style={{ color: "#9aa0a6", fontSize: 11, textAlign: "right" }}>{value}</span>
            </div>
          ))}
        </div>

        <div className="warn-box" style={{ marginBottom: 16 }}>
          <span style={{ color: "#ffd60a" }}>⚠️</span> You'll sign one message in MetaMask. It moves no
          funds. The agent's key is generated locally in your browser. (A second signature appears only
          if you've enabled paid AI analysis — a separate spend cap.)
        </div>

        <Collapsible title="Technical details (ERC-7710 delegation)" accent="#6366f1">
          <p style={{ color: "#6b7280", fontSize: 11, lineHeight: 1.7, marginBottom: 12 }}>
            Your smart account creates a scoped delegation to a Coordinator agent, which re-delegates an
            attenuated permission to a Revoker sub-agent (agent-to-agent). The scope is restricted to
            <code style={{ color: "#f1fa8c" }}> approve(address, 0)</code> on ERC-20 contracts only, with
            on-chain caveats for the call limit and expiry.
          </p>
          <div className="code-preview">
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
        </Collapsible>

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
            Couldn't grant the permission: {delegationError}
          </div>
        )}
        <button className="btn btn-primary" style={{ width: "100%", padding: 12, fontSize: 13, marginTop: 16 }} onClick={grantDelegation}>
          Sign in MetaMask to continue
        </button>
      </div>
    </div>
  );
}

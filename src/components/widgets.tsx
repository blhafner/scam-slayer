/**
 * widgets.tsx — shared mini-components (moved out of App.tsx).
 */

import { useState } from "react";

export function Pulse({ color = "#00ff9d", size = 8 }: { color?: string; size?: number }) {
  return <span style={{ display: "inline-block", width: size, height: size, borderRadius: "50%", backgroundColor: color, boxShadow: `0 0 ${size}px ${color}, 0 0 ${size * 2}px ${color}40`, animation: "pulse 2s ease-in-out infinite" }} />;
}

export function RiskBar({ score }: { score: number }) {
  const color = score > 75 ? "#ff2d55" : score > 40 ? "#ffd60a" : "#00ff9d";
  return (
    <div style={{ width: "100%", height: 4, backgroundColor: "#1a1a2e", borderRadius: 2, overflow: "hidden" }}>
      <div style={{ width: `${score}%`, height: "100%", backgroundColor: color, boxShadow: `0 0 8px ${color}60`, transition: "width 0.8s cubic-bezier(0.22,1,0.36,1)" }} />
    </div>
  );
}

/** Plain-language risk band for a heuristic score, so users see a word + color. */
export function riskLabel(score: number): { label: string; color: string } {
  if (score >= 90) return { label: "Critical", color: "#ff2d55" };
  if (score > 75) return { label: "High", color: "#ff2d55" };
  if (score > 40) return { label: "Medium", color: "#ffd60a" };
  return { label: "Low", color: "#00ff9d" };
}

/** Small inline "ⓘ" that reveals a plain-English definition on hover. */
export function InfoDot({ text }: { text: string }) {
  return (
    <span
      title={text}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 13,
        height: 13,
        borderRadius: "50%",
        border: "1px solid #4a5568",
        color: "#6b7280",
        fontSize: 9,
        fontStyle: "normal",
        cursor: "help",
        marginLeft: 5,
        verticalAlign: "middle",
      }}
    >
      ?
    </span>
  );
}

/**
 * Collapsible section — used to demote advanced/technical panels (A2A chain,
 * x402 budget, testing tools) so the core product reads first. Collapsed by
 * default unless defaultOpen.
 */
export function Collapsible({
  title,
  subtitle,
  badge,
  accent = "#6b7280",
  defaultOpen = false,
  children,
}: {
  title: string;
  subtitle?: string;
  badge?: string;
  accent?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card" style={{ marginBottom: 16, padding: 0, overflow: "hidden" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: 16,
          fontFamily: "inherit",
          textAlign: "left",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ color: accent, fontSize: 11, transition: "transform 0.15s", transform: open ? "rotate(90deg)" : "none" }}>▸</span>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#c8ccd0" }}>{title}</div>
            {subtitle && <div style={{ fontSize: 10, color: "#4a5568", marginTop: 2 }}>{subtitle}</div>}
          </div>
        </div>
        {badge && (
          <span className="tag" style={{ backgroundColor: `${accent}20`, color: accent }}>
            {badge}
          </span>
        )}
      </button>
      {open && <div style={{ padding: "0 16px 16px" }}>{children}</div>}
    </div>
  );
}

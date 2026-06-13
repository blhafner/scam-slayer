/**
 * widgets.tsx — shared mini-components (moved out of App.tsx).
 */

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

/**
 * ToastStack.tsx — toast notifications (moved out of App.tsx).
 * Reads toasts from the store; click dismisses.
 */

import { useAppStore, type Toast } from "../store/appStore";

export function ToastStack() {
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);

  const tone: Record<Toast["type"], { bg: string; bd: string; fg: string; icon: string }> = {
    info: { bg: "#12121e", bd: "#6366f140", fg: "#c8ccd0", icon: "ℹ" },
    success: { bg: "#0c1a14", bd: "#00ff9d40", fg: "#00ff9d", icon: "✓" },
    warn: { bg: "#1a160a", bd: "#ffd60a40", fg: "#ffd60a", icon: "⚠" },
    danger: { bg: "#1a0c12", bd: "#ff2d5540", fg: "#ff2d55", icon: "🗡️" },
  };
  return (
    <div style={{ position: "fixed", top: 64, right: 16, zIndex: 300, display: "flex", flexDirection: "column", gap: 8, maxWidth: 320 }}>
      {toasts.map((t) => {
        const c = tone[t.type];
        return (
          <div
            key={t.id}
            onClick={() => dismissToast(t.id)}
            style={{
              background: c.bg,
              border: `1px solid ${c.bd}`,
              borderRadius: 8,
              padding: "10px 14px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              cursor: "pointer",
              boxShadow: `0 4px 24px ${c.bd}`,
              animation: "toastIn 0.3s cubic-bezier(0.22,1,0.36,1)",
            }}
          >
            <span style={{ fontSize: 14 }}>{c.icon}</span>
            <span style={{ fontSize: 11, color: c.fg, lineHeight: 1.5 }}>{t.msg}</span>
          </div>
        );
      })}
    </div>
  );
}

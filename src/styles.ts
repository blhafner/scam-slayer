/**
 * styles.ts — global style objects + CSS string (moved out of App.tsx).
 */

import type React from "react";
import type { LogEntry } from "./lib/types";

export const logColor = (entry: LogEntry) => {
  switch (entry.level) {
    case "danger": return "#ff2d55";
    case "success": return "#00ff9d";
    case "warn": return "#ffd60a";
    case "ai": return "#6366f1";
    default: return "#4a5568";
  }
};

export const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: "100vh",
    backgroundColor: "#0a0a14",
    color: "#c8ccd0",
    fontFamily: "'JetBrains Mono','Fira Code',monospace",
    fontSize: 13,
    lineHeight: 1.5,
  },
  header: {
    padding: "12px 24px",
    borderBottom: "1px solid #1e1e3a",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: "#0a0a1480",
    backdropFilter: "blur(10px)",
    position: "sticky",
    top: 0,
    zIndex: 50,
  },
  title: {
    fontFamily: "'Space Grotesk',sans-serif",
    fontSize: 16,
    fontWeight: 700,
    color: "#fff",
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 10,
    color: "#4a5568",
    letterSpacing: 1,
    textTransform: "uppercase" as const,
  },
  main: { padding: 24, maxWidth: 1400, margin: "0 auto" },
};

export const CSS = `
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}
@keyframes killFlash{0%{background:transparent}50%{background:#ff2d5520}100%{background:transparent}}
@keyframes slideIn{from{opacity:0;transform:translateX(-20px)}to{opacity:1;transform:translateX(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes glowPulse{0%,100%{box-shadow:0 0 20px #00ff9d10}50%{box-shadow:0 0 40px #00ff9d20}}
.card{background:linear-gradient(135deg,#12121e,#0d0d18);border:1px solid #1e1e3a;border-radius:8px;padding:16px;transition:border-color .2s}
.card:hover{border-color:#2a2a50}
.btn{border:none;border-radius:6px;padding:8px 16px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:all .2s;text-transform:uppercase;letter-spacing:.5px}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-primary{background:linear-gradient(135deg,#00ff9d,#00cc7d);color:#0a0a14}
.btn-primary:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 4px 20px #00ff9d30}
.btn-danger{background:linear-gradient(135deg,#ff2d55,#cc1a3a);color:#fff}
.btn-danger:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 4px 20px #ff2d5530}
.btn-ghost{background:transparent;color:#6b7280;border:1px solid #1e1e3a}
.btn-ghost:hover:not(:disabled){border-color:#3a3a60;color:#c8ccd0}
.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;letter-spacing:.5px;text-transform:uppercase}
.kill-flash{animation:killFlash .3s ease-out 5}
.addr-pill{display:flex;align-items:center;gap:6px;padding:4px 12px;background:#12121e;border:1px solid #1e1e3a;border-radius:6px;font-size:11px}
.text-input{background:#0a0a14;border:1px solid #1e1e3a;border-radius:6px;padding:8px 12px;color:#c8ccd0;font-family:inherit;font-size:12px;outline:none}
.text-input:focus{border-color:#3a3a60}
.caveat-box{background:#0a0a14;border-radius:6px;padding:16px;margin-bottom:20px;border:1px solid #1e1e3a}
.warn-box{background:#0a0a14;border-radius:6px;padding:12px;border:1px solid #1e1e3a;font-size:10px;color:#4a5568;line-height:1.8}
.code-preview{background:#0a0a14;border-radius:6px;padding:12px;border:1px solid #1e1e3a;font-size:10px;color:#6366f1;line-height:1.8;font-family:'JetBrains Mono',monospace;overflow-x:auto}
.code-preview .kw{color:#ff79c6}
.code-preview .str{color:#f1fa8c}
.code-preview .num{color:#bd93f9}
.code-preview .indent{padding-left:16px}
.code-preview .indent2{padding-left:24px}
::-webkit-scrollbar{width:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#1e1e3a;border-radius:2px}
@keyframes toastIn{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:translateX(0)}}
.ext-link{color:#6366f1;text-decoration:none;border-bottom:1px dotted #6366f150;transition:color .15s}
.ext-link:hover{color:#8b8ef5;border-bottom-color:#8b8ef5}
.stats-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:16px}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:860px){
  .stats-grid{grid-template-columns:repeat(2,1fr)}
  .two-col{grid-template-columns:1fr}
}
@media (max-width:520px){
  .stats-grid{grid-template-columns:1fr}
  .app-main{padding:12px !important}
}
`;

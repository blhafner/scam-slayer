/**
 * SettingsModal.tsx — settings dialog (moved out of App.tsx).
 * Local draft state for fields; persists via the store's saveConfig.
 */

import { useState } from "react";
import type { AppConfig } from "../lib/types";
import { useAppStore } from "../store/appStore";
import { testApiKey } from "../lib/venice";
import {
  getStoredAgentKey,
  getStoredAgentAddress,
  importAgentKey,
  shortenAddress,
} from "../lib/wallet";

export function SettingsModal() {
  const config = useAppStore((s) => s.config);
  const saveConfig = useAppStore((s) => s.saveConfig);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const onClose = () => setShowSettings(false);

  const [venice, setVenice] = useState(config.veniceApiKey);
  const [alchemy, setAlchemy] = useState(config.alchemyApiKey);
  const [pimlico, setPimlico] = useState(config.pimlicoApiKey);
  const [etherscan, setEtherscan] = useState(config.etherscanApiKey);
  const [x402, setX402] = useState(config.x402Enabled);
  const [relayerMode, setRelayerMode] = useState<AppConfig["relayerMode"]>(config.relayerMode);
  const [webhook, setWebhook] = useState(config.webhookUrl);
  const [testResult, setTestResult] = useState<"ok" | "fail" | "testing" | null>(null);

  // Agent payer key backup / restore. The key controls the funded x402 wallet
  // and lives only in localStorage, so we expose reveal-to-back-up and import-
  // to-restore (e.g. recover a wallet whose key was wiped or made on another origin).
  const [revealKey, setRevealKey] = useState(false);
  const [importValue, setImportValue] = useState("");
  const [keyMsg, setKeyMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const storedKey = getStoredAgentKey();
  const storedAddr = getStoredAgentAddress();

  const handleImportKey = () => {
    // Guard against silently clobbering a key you haven't backed up.
    if (
      storedAddr &&
      !confirm(
        `Replace the current agent key?\n\nThe current payer wallet ${storedAddr} will no longer be accessible from this app unless you've backed up its key. Continue?`
      )
    ) {
      return;
    }
    try {
      const addr = importAgentKey(importValue);
      setKeyMsg({ kind: "ok", text: `Imported. Payer wallet is now ${shortenAddress(addr)}. Reloading…` });
      setTimeout(() => location.reload(), 1200);
    } catch {
      setKeyMsg({ kind: "err", text: "Invalid private key (need a 32-byte hex key, 0x-prefixed)." });
    }
  };

  const handleTest = async () => {
    setTestResult("testing");
    setTestResult((await testApiKey(venice)) ? "ok" : "fail");
  };

  return (
    <div style={{ position: "fixed", inset: 0, backgroundColor: "#0a0a14e0", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, backdropFilter: "blur(4px)" }}>
      <div className="card" style={{ width: 480, padding: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontSize: 16, fontWeight: 700, color: "#fff" }}>⚙️ Settings</span>
          <button className="btn btn-ghost" style={{ padding: "2px 8px", fontSize: 10 }} onClick={onClose}>✕</button>
        </div>
        {[
          { label: "Venice AI Key", val: venice, set: setVenice, ph: "vapi_...", test: handleTest, status: testResult },
          { label: "Alchemy Key", val: alchemy, set: setAlchemy, ph: "Alchemy key (works across all chains)" },
          { label: "Etherscan Key", val: etherscan, set: setEtherscan, ph: "Contract age + verification (optional)" },
          { label: "Pimlico Key", val: pimlico, set: setPimlico, ph: "Bundler (optional)" },
        ].map((f, i) => (
          <div key={i} style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 10, color: "#4a5568", textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 6 }}>{f.label}</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="password" value={f.val} onChange={(e) => f.set(e.target.value)} placeholder={f.ph} className="text-input" style={{ flex: 1 }} />
              {f.test && (
                <button className="btn btn-ghost" style={{ padding: "6px 12px", fontSize: 10 }} onClick={f.test}>
                  {f.status === "testing" ? "..." : f.status === "ok" ? "✓" : f.status === "fail" ? "✗" : "Test"}
                </button>
              )}
            </div>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderTop: "1px solid #1e1e3a", marginTop: 8 }}>
          <div>
            <div style={{ fontSize: 11, color: "#fff", fontWeight: 600 }}>💸 Pay via x402</div>
            <div style={{ fontSize: 10, color: "#4a5568" }}>Agent pays USDC on Base per inference — no API key</div>
          </div>
          <button
            className="btn btn-ghost"
            style={{ padding: "6px 14px", fontSize: 10, color: x402 ? "#00ff9d" : "#6b7280", borderColor: x402 ? "#00ff9d40" : "#1e1e3a" }}
            onClick={() => setX402(!x402)}
          >
            {x402 ? "ON" : "OFF"}
          </button>
        </div>
        <div style={{ padding: "12px 0", borderTop: "1px solid #1e1e3a" }}>
          <div style={{ fontSize: 11, color: "#fff", fontWeight: 600, marginBottom: 8 }}>⛽ Revocation relayer</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            {(["pimlico", "1shot"] as const).map((m) => (
              <button
                key={m}
                className="btn btn-ghost"
                style={{ flex: 1, padding: "8px 0", fontSize: 10, color: relayerMode === m ? "#00ff9d" : "#6b7280", borderColor: relayerMode === m ? "#00ff9d40" : "#1e1e3a" }}
                onClick={() => setRelayerMode(m)}
              >
                {m === "pimlico" ? "Pimlico (ETH gas)" : "1Shot (USDC gas + 7702)"}
              </button>
            ))}
          </div>
          {relayerMode === "1shot" && (
            <input
              value={webhook}
              onChange={(e) => setWebhook(e.target.value)}
              placeholder="1Shot webhook URL (optional — else polls status)"
              className="text-input"
              style={{ width: "100%" }}
            />
          )}
        </div>
        <div style={{ padding: "12px 0", borderTop: "1px solid #1e1e3a" }}>
          <div style={{ fontSize: 11, color: "#fff", fontWeight: 600, marginBottom: 6 }}>🔐 Local key custody</div>
          <div style={{ fontSize: 10, color: "#4a5568", lineHeight: 1.6, marginBottom: 10 }}>
            The agent key funds x402 payments and is stored ONLY in this browser's localStorage.
            <span style={{ color: "#ffd60a" }}> Back it up before funding</span> — if it's cleared, or the app
            is opened on a different URL (e.g. localhost vs 127.0.0.1), a new key is generated and the old
            wallet is unrecoverable. Treat it like a hot wallet; keep only small balances.
          </div>

          {storedAddr && (
            <div style={{ fontSize: 10, color: "#c8ccd0", marginBottom: 8 }}>
              Current payer wallet: <span style={{ fontFamily: "monospace" }}>{storedAddr}</span>
            </div>
          )}

          {storedKey && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                <button
                  className="btn btn-ghost"
                  style={{ flex: 1, padding: 6, fontSize: 10 }}
                  onClick={() => setRevealKey((v) => !v)}
                >
                  {revealKey ? "Hide key" : "Reveal key to back up"}
                </button>
                <button
                  className="btn btn-ghost"
                  style={{ flex: 1, padding: 6, fontSize: 10 }}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(storedKey);
                      setKeyMsg({ kind: "ok", text: "Private key copied — store it somewhere safe (e.g. a password manager)." });
                    } catch {
                      setKeyMsg({ kind: "err", text: "Clipboard unavailable (needs a secure context) — reveal and copy manually." });
                    }
                  }}
                >
                  Copy key
                </button>
              </div>
              {revealKey && (
                <div style={{ fontFamily: "monospace", fontSize: 9, color: "#ffd60a", wordBreak: "break-all", background: "#1a1a2e", padding: 8, borderRadius: 6, lineHeight: 1.5 }}>
                  {storedKey}
                </div>
              )}
            </div>
          )}

          <div style={{ marginBottom: 10 }}>
            <input
              value={importValue}
              onChange={(e) => setImportValue(e.target.value)}
              placeholder="Restore a funded wallet: paste its private key (0x…)"
              className="text-input"
              type="password"
              style={{ width: "100%", marginBottom: 6, fontFamily: "monospace", fontSize: 10 }}
            />
            <button
              className="btn btn-ghost"
              style={{ width: "100%", padding: 6, fontSize: 10 }}
              disabled={!importValue.trim()}
              onClick={handleImportKey}
            >
              Import agent key (restore payer wallet)
            </button>
          </div>

          {keyMsg && (
            <div style={{ fontSize: 10, color: keyMsg.kind === "ok" ? "#00ff9d" : "#ff9aa2", marginBottom: 10 }}>
              {keyMsg.text}
            </div>
          )}

          <button
            className="btn btn-ghost"
            style={{ width: "100%", padding: 8, fontSize: 10, color: "#ff9aa2", borderColor: "#ff2d5540" }}
            onClick={() => {
              if (confirm("Wipe the locally-stored agent + sub-agent private keys? Any USDC in the agent wallet will be unrecoverable from this app. New keys are generated on next connect.")) {
                localStorage.removeItem("scamslayer-agent-key");
                localStorage.removeItem("scamslayer-subagent-key");
                location.reload();
              }
            }}
          >
            Reset Agent Keys (wipe local private keys)
          </button>
        </div>
        <button className="btn btn-primary" style={{ width: "100%", padding: 10, marginTop: 8 }} onClick={() => { saveConfig({ chainId: config.chainId, veniceApiKey: venice, alchemyApiKey: alchemy, pimlicoApiKey: pimlico, etherscanApiKey: etherscan, x402Enabled: x402, relayerMode, webhookUrl: webhook }); onClose(); }}>
          Save
        </button>
      </div>
    </div>
  );
}

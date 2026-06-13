/**
 * App.tsx — Scam Slayer application shell.
 *
 * Thin orchestrator after the store refactor:
 * - header (chain select, live/demo tag, agent pause, connect)
 * - view routing (landing → delegation grant → dashboard)
 * - background effects (scan loop, auto-rescan, autonomous sweep, x402 refresh)
 *
 * All app state + actions live in store/appStore.ts; SDK account handles in
 * store/runtime.ts; views in components/.
 */

import { useState, useEffect } from "react";
import { useAppStore } from "./store/appStore";
import { runtime } from "./store/runtime";
import { shortenAddress } from "./lib/wallet";
import { CHAIN_LIST, CHAINS, setActiveChain } from "./lib/chains";
import { styles, CSS } from "./styles";
import { LandingView } from "./components/LandingView";
import { DelegationView } from "./components/DelegationView";
import { DashboardView } from "./components/DashboardView";
import { SettingsModal } from "./components/SettingsModal";
import { ToastStack } from "./components/ToastStack";
import { Pulse } from "./components/widgets";

function Clock() {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span style={{ fontSize: 11, color: "#4a5568" }}>
      {time.toLocaleTimeString()}
    </span>
  );
}

export default function App() {
  const config = useAppStore((s) => s.config);
  const showSettings = useAppStore((s) => s.showSettings);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const walletConnected = useAppStore((s) => s.walletConnected);
  const eoaAddress = useAppStore((s) => s.eoaAddress);
  const delegationGranted = useAppStore((s) => s.delegationGranted);
  const agentActive = useAppStore((s) => s.agentActive);
  const setAgentActive = useAppStore((s) => s.setAgentActive);
  const demoMode = useAppStore((s) => s.demoMode);
  const autoMode = useAppStore((s) => s.autoMode);
  const autoThreshold = useAppStore((s) => s.autoThreshold);
  const approvals = useAppStore((s) => s.approvals);
  const connect = useAppStore((s) => s.connect);
  const changeChain = useAppStore((s) => s.changeChain);

  // Keep the chains module's active chain in sync with config — this drives all
  // RPC, wallet, scanner, and explorer-link behavior across the app.
  useEffect(() => {
    setActiveChain(config.chainId);
  }, [config.chainId]);

  // Refresh the x402 payer status whenever a live x402 session begins.
  useEffect(() => {
    if (!walletConnected || !config.x402Enabled) return;
    useAppStore.getState().refreshX402Status();
  }, [walletConnected, config.x402Enabled]);

  // Continuous auto-scan: while connected to a live wallet, re-read on-chain
  // approvals on a timer regardless of agent/delegation state, so new threats are
  // picked up automatically (no manual Rescan / page refresh). Throttled via
  // runtime.lastRescan to stay within RPC limits; new threats alert via
  // applyApprovals.
  useEffect(() => {
    if (!walletConnected || demoMode) return;
    // Need an Alchemy key only on Alchemy-served chains; PulseChain uses public RPC.
    if (CHAINS[config.chainId]?.alchemySubdomain && !config.alchemyApiKey) return;
    const id = setInterval(() => {
      const { rescanning, rescan } = useAppStore.getState();
      if (!rescanning && Date.now() - runtime.lastRescan > 30_000) {
        runtime.lastRescan = Date.now();
        rescan(true);
      }
    }, 10_000);
    return () => clearInterval(id);
  }, [walletConnected, demoMode, config.alchemyApiKey, config.chainId]);

  // Scan loop — drives the progress bar AND triggers a real on-chain rescan on
  // each completed cycle (throttled inside runScanTick), so "scanning" reflects
  // live state instead of being purely cosmetic.
  useEffect(() => {
    if (!agentActive || !delegationGranted) return;
    const t = setInterval(() => {
      useAppStore.getState().runScanTick();
    }, 200);
    return () => clearInterval(t);
  }, [agentActive, delegationGranted]);

  // Trigger the sweep automatically whenever auto mode is on and a qualifying
  // threat is present.
  useEffect(() => {
    if (!autoMode || !agentActive || !delegationGranted) return;
    if (
      approvals.some(
        (a) => a.riskScore >= autoThreshold && !runtime.sweptIds.has(a.id)
      )
    ) {
      useAppStore.getState().sweep();
    }
  }, [autoMode, agentActive, delegationGranted, approvals, autoThreshold]);

  // ---- Derived state ----
  const isLive = !!config.veniceApiKey || config.x402Enabled;
  // Smart-account delegation / A2A flow is Sepolia-only; other chains go straight
  // to the dashboard for scan + direct revocation.
  const chainSupportsDelegation = !!CHAINS[config.chainId]?.supportsSmartAccountDemo;

  // ---- Render ----
  return (
    <div style={styles.root}>
      <style>{CSS}</style>

      {/* Toasts */}
      <ToastStack />

      {/* Settings Modal */}
      {showSettings && <SettingsModal />}

      {/* Header */}
      <header style={styles.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 20 }}>🗡️</span>
          <div>
            <div style={styles.title}>SCAM SLAYER</div>
            <div style={styles.subtitle}>Autonomous Security Agent</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <select
            value={config.chainId}
            onChange={(e) => changeChain(Number(e.target.value))}
            disabled={demoMode}
            title="Select chain to scan + revoke on"
            style={{
              background: "#0a0a14",
              border: "1px solid #1e1e3a",
              borderRadius: 6,
              color: "#c8ccd0",
              fontSize: 11,
              fontFamily: "inherit",
              padding: "5px 8px",
              outline: "none",
              cursor: demoMode ? "not-allowed" : "pointer",
            }}
          >
            {CHAIN_LIST.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <Clock />
          <span
            className="tag"
            style={{
              backgroundColor: demoMode ? "#6366f120" : isLive ? "#00ff9d20" : "#ffd60a20",
              color: demoMode ? "#6366f1" : isLive ? "#00ff9d" : "#ffd60a",
              cursor: "pointer",
            }}
            onClick={() => setShowSettings(true)}
          >
            {demoMode ? "DEMO" : isLive ? "LIVE" : "DEMO"}
          </span>
          {delegationGranted && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Pulse color={agentActive ? "#00ff9d" : "#ff2d55"} />
              <span style={{ fontSize: 11, color: agentActive ? "#00ff9d" : "#ff2d55" }}>
                {agentActive ? "ACTIVE" : "PAUSED"}
              </span>
              <button
                className="btn btn-ghost"
                style={{ padding: "4px 10px", fontSize: 10 }}
                onClick={() => setAgentActive(!agentActive)}
              >
                {agentActive ? "PAUSE" : "RESUME"}
              </button>
            </div>
          )}
          <button
            className="btn btn-ghost"
            style={{ padding: "4px 10px", fontSize: 10 }}
            onClick={() => setShowSettings(true)}
          >
            ⚙️
          </button>
          {walletConnected ? (
            <div className="addr-pill">
              <Pulse color="#00ff9d" size={6} />
              <span>{eoaAddress ? shortenAddress(eoaAddress) : "Demo"}</span>
            </div>
          ) : (
            <button className="btn btn-primary" onClick={connect}>
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      {/* Main */}
      <div className="app-main" style={styles.main}>
        {!walletConnected ? (
          <LandingView />
        ) : chainSupportsDelegation && !delegationGranted ? (
          <DelegationView />
        ) : (
          <DashboardView />
        )}
      </div>
    </div>
  );
}

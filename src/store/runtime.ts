/**
 * runtime.ts — non-reactive session handles.
 *
 * SDK account instances, signed delegations, and bookkeeping sets that must
 * survive across renders but never drive them. These lived in useRefs inside
 * App.tsx before the store refactor; they are deliberately kept OUT of the
 * zustand store so state updates stay serializable and devtools-friendly.
 */

import type { Hex } from "viem";

export const runtime = {
  // SDK smart-account instances (MetaMask Smart Accounts Kit).
  operatorAccount: null as any,
  agentAccount: null as any,
  subAgentAccount: null as any,
  // Agent EOA private key — funds x402 payments for inference.
  agentPrivateKey: null as Hex | null,
  // Signed delegations ordered leaf → root: [coordinator→revoker, operator→coordinator]
  delegationChain: [] as any[],
  // Signed operator→agent USDC spend-cap delegation (x402 budget).
  budgetDelegation: null as any,
  // Agent 7702 stateless-delegator account for the 1Shot relayer path.
  agent7702: null as any,
  agent7702Upgraded: false,

  // Sweep re-entrancy guard + ids the autonomous sweep already attempted, so a
  // kept (failed) approval is not retried in an infinite loop.
  sweeping: false,
  sweptIds: new Set<string>(),

  // Rescan throttle + approval ids seen on a previous scan (used to flag NEW
  // threats that appear between scans).
  lastRescan: 0,
  knownApprovalIds: new Set<string>(),
};

/** Reset connection-scoped handles (called on reconnect). */
export function resetAccountRuntime() {
  runtime.operatorAccount = null;
  runtime.agentAccount = null;
  runtime.subAgentAccount = null;
  runtime.agent7702 = null;
}

/**
 * scanner.integration.test.ts — end-to-end scan against a local Anvil chain.
 *
 * Deploys a real ERC-20 to a fresh Anvil node, seeds an on-chain approval
 * (unlimited allowance to an unknown spender), runs the ACTUAL `fetchApprovals`
 * against the node, and asserts:
 *   1. the approval is detected, flagged unlimited, and risk-scored as a threat;
 *   2. after the owner revokes (approve → 0), a rescan drops it (allowance 0).
 *
 * This exercises the full pipeline the unit tests can't: Approval-event getLogs
 * discovery, the live allowance/symbol/decimals/balance multicall (via Anvil's
 * predeployed Multicall3), and the revoked-drop rule — through the same
 * getPublicClient the app uses, pointed at Anvil via setRpcOverride.
 *
 * Hermetic by design: a fresh Anvil (no fork) means every block is local, so
 * the scanner's deep getLogs window clamps to block 0 and never needs a remote
 * provider. Opt-in: runs only with RUN_INTEGRATION=1 AND `anvil` on PATH; plain
 * `npm test` skips it. Use `npm run test:integration`.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  maxUint256,
  getAddress,
  parseEther,
  type Address,
} from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { fetchApprovals } from "./scanner";
import { setActiveChain, setRpcOverride } from "./chains";
import {
  MOCK_ERC20_BYTECODE,
  MOCK_ERC20_ABI,
  MULTICALL3_ADDRESS,
  MULTICALL3_RUNTIME,
} from "./mockErc20";

// An unknown, non-KNOWN_SAFE spender → should score as a threat.
const SPENDER: Address = getAddress("0x00000000000000000000000000000000DeaDBeef");

// Anvil default account[0] — funded with ETH; deploys the token and signs txs.
const OWNER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const ANVIL_PORT = 8651;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

function anvilAvailable(): boolean {
  try {
    execSync("anvil --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const RUN = process.env.RUN_INTEGRATION === "1" && anvilAvailable();

async function waitForRpc(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok && (await res.json())?.result) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Anvil RPC not ready at ${url} within ${timeoutMs}ms`);
}

describe.skipIf(!RUN)("scanner integration (Anvil)", () => {
  let anvil: ChildProcess;
  let token: Address;
  const owner = privateKeyToAccount(OWNER_PK as `0x${string}`);
  // chain is `sepolia` only so the app's config (wideRange, Multicall3 address)
  // matches; Anvil predeploys Multicall3 at the same canonical address.
  const walletClient = createWalletClient({ account: owner, chain: sepolia, transport: http(ANVIL_URL) });
  const publicClient = createPublicClient({ chain: sepolia, transport: http(ANVIL_URL) });

  beforeAll(async () => {
    anvil = spawn(
      "anvil",
      ["--port", String(ANVIL_PORT), "--silent", "--chain-id", String(sepolia.id)],
      { stdio: "ignore" }
    );
    await waitForRpc(ANVIL_URL);

    // Fresh Anvil has no Multicall3; the scanner's batched reads need one at the
    // canonical address viem uses. Inject a minimal aggregate3 implementation.
    await fetch(ANVIL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "anvil_setCode",
        params: [MULTICALL3_ADDRESS, MULTICALL3_RUNTIME],
      }),
    });

    // Deploy the mock token: MockERC20("MOCK", 18, 1_000_000e18) → mints to owner.
    const deployHash = await walletClient.deployContract({
      abi: MOCK_ERC20_ABI,
      bytecode: MOCK_ERC20_BYTECODE,
      args: ["MOCK", 18, parseEther("1000000")],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    if (!receipt.contractAddress) throw new Error("token deploy produced no address");
    token = getAddress(receipt.contractAddress);

    // Route the app's getPublicClient at Anvil; scan on Sepolia config.
    setActiveChain(sepolia.id);
    setRpcOverride(ANVIL_URL);
  }, 60_000);

  afterAll(() => {
    setRpcOverride(null);
    anvil?.kill("SIGKILL");
  });

  it("detects a seeded unlimited approval and drops it after revocation", async () => {
    // --- Seed: owner grants an unlimited approval to an unknown spender ---
    const approveHash = await walletClient.writeContract({
      address: token,
      abi: MOCK_ERC20_ABI,
      functionName: "approve",
      args: [SPENDER, maxUint256],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    // --- Scan via the real pipeline (no Alchemy/Etherscan keys) ---
    const found = await fetchApprovals(owner.address, "", "", "eoa");
    const hit = found.find(
      (a) =>
        a.tokenAddress.toLowerCase() === token.toLowerCase() &&
        a.spender.toLowerCase() === SPENDER.toLowerCase()
    );

    expect(hit, "seeded approval should be detected").toBeDefined();
    expect(hit!.isMaxApproval).toBe(true);
    expect(hit!.token).toBe("MOCK");
    expect(hit!.ownerType).toBe("eoa");
    // Unknown spender + unlimited (+ no etherscan key → unknown age/verify):
    // comfortably above the analyzing/threat threshold.
    expect(hit!.riskScore).toBeGreaterThan(40);
    // Owner holds the full supply → exposure = balance (allowance is larger).
    expect(hit!.exposureTokens).toBe(1_000_000);

    // --- Revoke: owner zeroes the allowance ---
    const revokeHash = await walletClient.writeContract({
      address: token,
      abi: MOCK_ERC20_ABI,
      functionName: "approve",
      args: [SPENDER, 0n],
    });
    await publicClient.waitForTransactionReceipt({ hash: revokeHash });

    // --- Rescan: the now-zero allowance must be dropped ---
    const after = await fetchApprovals(owner.address, "", "", "eoa");
    const stillThere = after.find(
      (a) =>
        a.tokenAddress.toLowerCase() === token.toLowerCase() &&
        a.spender.toLowerCase() === SPENDER.toLowerCase()
    );
    expect(stillThere, "revoked approval should be dropped on rescan").toBeUndefined();
  }, 120_000);
});

/**
 * oneshot.test.ts — relayer bundle construction.
 *
 * The critical property under test: the revocation redemption is routed through
 * the operator-rooted delegation chain (leaf → root, leaf delegate = relayer
 * wallet), NOT through an agent-signed delegation — so approve(spender, 0)
 * executes from the operator smart account that owns the approval. The agent's
 * delegation pays the USDC fee only.
 */

import { describe, it, expect } from "vitest";
import { decodeFunctionData, parseAbi, erc20Abi, type Address } from "viem";
import { buildRelayerBundle } from "./oneshot";

const APPROVE_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const RELAYER_TARGET = "0x1111111111111111111111111111111111111111" as Address;
const OPERATOR = "0x2222222222222222222222222222222222222222" as Address;
const COORDINATOR = "0x3333333333333333333333333333333333333333" as Address;
const FEE_COLLECTOR = "0x4444444444444444444444444444444444444444" as Address;
const USDC = "0x5555555555555555555555555555555555555555" as Address;
const TOKEN = "0x6666666666666666666666666666666666666666" as Address;
const SPENDER = "0x7777777777777777777777777777777777777777" as Address;
const AGENT = "0x8888888888888888888888888888888888888888" as Address;

// Minimal signed-delegation shapes; bigint salt exercises toRelayerJson.
const feeDelegation = {
  delegate: RELAYER_TARGET,
  delegator: AGENT,
  salt: 42n,
  signature: "0xfee",
};
const relayerLeaf = {
  delegate: RELAYER_TARGET,
  delegator: COORDINATOR,
  salt: 7n,
  signature: "0xleaf",
};
const rootDelegation = {
  delegate: COORDINATOR,
  delegator: OPERATOR,
  salt: 0n,
  signature: "0xroot",
};

function build(overrides: Partial<Parameters<typeof buildRelayerBundle>[0]> = {}) {
  return buildRelayerBundle({
    chainId: 11155111,
    signedFeeDelegation: feeDelegation,
    signedRevocationChain: [relayerLeaf, rootDelegation],
    usdcAddress: USDC,
    feeCollector: FEE_COLLECTOR,
    feeAmount: 12_345n,
    tokenAddress: TOKEN,
    spender: SPENDER,
    ...overrides,
  });
}

describe("buildRelayerBundle", () => {
  it("routes the revocation through the operator-rooted chain (leaf → root)", () => {
    const bundle = build();
    const revokeTx = bundle.transactions[1] as any;

    // Chain order: [coordinator→relayer leaf, operator→coordinator root].
    expect(revokeTx.permissionContext).toHaveLength(2);
    expect(revokeTx.permissionContext[0].delegate).toBe(RELAYER_TARGET);
    expect(revokeTx.permissionContext[0].delegator).toBe(COORDINATOR);
    expect(revokeTx.permissionContext[1].delegate).toBe(COORDINATOR);
    // Root delegator = operator smart account → execution runs as the operator.
    expect(revokeTx.permissionContext[1].delegator).toBe(OPERATOR);
  });

  it("encodes approve(spender, 0) against the approval's token", () => {
    const bundle = build();
    const revokeTx = bundle.transactions[1] as any;
    expect(revokeTx.executions).toHaveLength(1);
    expect(revokeTx.executions[0].target).toBe(TOKEN);
    expect(revokeTx.executions[0].value).toBe("0");

    const decoded = decodeFunctionData({
      abi: APPROVE_ABI,
      data: revokeTx.executions[0].data,
    });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args).toEqual([SPENDER, 0n]);
  });

  it("keeps the fee redemption separate, paid via the agent's own delegation", () => {
    const bundle = build();
    const feeTx = bundle.transactions[0] as any;

    expect(feeTx.permissionContext).toHaveLength(1);
    expect(feeTx.permissionContext[0].delegator).toBe(AGENT);
    expect(feeTx.permissionContext[0].delegate).toBe(RELAYER_TARGET);

    expect(feeTx.executions).toHaveLength(1);
    expect(feeTx.executions[0].target).toBe(USDC);
    const decoded = decodeFunctionData({
      abi: erc20Abi,
      data: feeTx.executions[0].data,
    });
    expect(decoded.functionName).toBe("transfer");
    expect(decoded.args).toEqual([FEE_COLLECTOR, 12_345n]);

    // The fee redemption must NOT carry the revocation call (the old, broken
    // shape bundled approve() into the agent-signed transaction).
    const feeSelectors = feeTx.executions.map((e: any) => e.data.slice(0, 10));
    expect(feeSelectors).not.toContain("0x095ea7b3"); // approve(address,uint256)
  });

  it("serializes bigints to hex for the relayer JSON-RPC payload", () => {
    const bundle = build();
    const revokeTx = bundle.transactions[1] as any;
    expect(revokeTx.permissionContext[0].salt).toBe("0x7");
    expect(JSON.stringify(bundle)).not.toContain("42n");
  });

  it("includes the authorizationList only when upgrading", () => {
    expect(build()).not.toHaveProperty("authorizationList");
    const withAuth = build({ authorizationList: [{ nonce: 0 }] });
    expect((withAuth as any).authorizationList).toEqual([{ nonce: 0 }]);
    expect(withAuth.chainId).toBe("11155111");
  });
});

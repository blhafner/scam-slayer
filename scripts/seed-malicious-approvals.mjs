/**
 * seed-malicious-approvals.mjs — create real mock-malicious approvals on Sepolia.
 *
 * Deploys a fresh, UNVERIFIED Spender contract, then sends approve(token, MAX)
 * from a funded EOA to it across several Sepolia ERC-20s. The connecting wallet
 * (the funded key here) then shows these as EOA-owned threats in the app —
 * unlimited allowance to an unknown, unverified, brand-new spender — directly
 * revocable via the kill button. NOT verified on Etherscan on purpose.
 *
 * Usage:
 *   SEPOLIA_PK=0x<funded-key> node scripts/seed-malicious-approvals.mjs
 * Optional:
 *   SEPOLIA_RPC=<url>            (default: publicnode)
 *   TOKENS=USDC,WETH,LINK,DAI    (subset; default all)
 *
 * The owner needs a little Sepolia ETH for gas (one deploy + N approvals).
 * Get test ETH: https://sepoliafaucet.com / https://cloud.google.com/application/web3/faucet/ethereum/sepolia
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  maxUint256,
  getAddress,
} from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// Fresh, unverified Spender contract (compiled with solc 0.8.x via foundry).
const SPENDER_BYTECODE = "0x60a0604052348015600e575f5ffd5b503373ffffffffffffffffffffffffffffffffffffffff1660808173ffffffffffffffffffffffffffffffffffffffff168152505060805161044d61005b5f395f6101b4015261044d5ff3fe608060405234801561000f575f5ffd5b5060043610610034575f3560e01c8063496d38cf14610038578063d5f3948814610054575b5f5ffd5b610052600480360381019061004d9190610267565b610072565b005b61005c6101b2565b60405161006991906102da565b60405180910390f35b5f8473ffffffffffffffffffffffffffffffffffffffff1684848460405160240161009f93929190610302565b6040516020818303038152906040527f23b872dd000000000000000000000000000000000000000000000000000000007bffffffffffffffffffffffffffffffffffffffffffffffffffffffff19166020820180517bffffffffffffffffffffffffffffffffffffffffffffffffffffffff83818316178352505050506040516101299190610389565b5f604051808303815f865af19150503d805f8114610162576040519150601f19603f3d011682016040523d82523d5f602084013e610167565b606091505b50509050806101ab576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016101a2906103f9565b60405180910390fd5b5050505050565b7f000000000000000000000000000000000000000000000000000000000000000081565b5f5ffd5b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f610203826101da565b9050919050565b610213816101f9565b811461021d575f5ffd5b50565b5f8135905061022e8161020a565b92915050565b5f819050919050565b61024681610234565b8114610250575f5ffd5b50565b5f813590506102618161023d565b92915050565b5f5f5f5f6080858703121561027f5761027e6101d6565b5b5f61028c87828801610220565b945050602061029d87828801610220565b93505060406102ae87828801610220565b92505060606102bf87828801610253565b91505092959194509250565b6102d4816101f9565b82525050565b5f6020820190506102ed5f8301846102cb565b92915050565b6102fc81610234565b82525050565b5f6060820190506103155f8301866102cb565b61032260208301856102cb565b61032f60408301846102f3565b949350505050565b5f81519050919050565b5f81905092915050565b8281835e5f83830152505050565b5f61036382610337565b61036d8185610341565b935061037d81856020860161034b565b80840191505092915050565b5f6103948284610359565b915081905092915050565b5f82825260208201905092915050565b7f647261696e206661696c656400000000000000000000000000000000000000005f82015250565b5f6103e3600c8361039f565b91506103ee826103af565b602082019050919050565b5f6020820190508181035f830152610410816103d7565b905091905056fea2646970667358221220d6c7eb8fb68aa2a4600af6f5be79ddc415dfb2758e7c38a7fffbac05a476dcc764736f6c634300081e0033";

// Sepolia ERC-20s the app already scopes/scans.
const TOKENS = {
  USDC: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  WETH: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
  LINK: "0x779877A7B0D9E8603169DdbD7836e478b4624789",
  DAI: "0x68194a729C2450ad26072b3D33ADaCbcef39D574",
};

const ERC20 = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

async function main() {
  const pk = process.env.SEPOLIA_PK;
  if (!pk) {
    console.error("Set SEPOLIA_PK to a funded Sepolia private key (0x...).");
    process.exit(1);
  }
  const rpc = process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
  const pick = (process.env.TOKENS || "USDC,WETH,LINK,DAI")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => TOKENS[s]);

  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk);
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpc) });
  const pub = createPublicClient({ chain: sepolia, transport: http(rpc) });

  console.log("Owner (connect this wallet in the app):", account.address);
  const bal = await pub.getBalance({ address: account.address });
  console.log("Sepolia ETH balance:", Number(bal) / 1e18);
  if (bal === 0n) {
    console.error("Owner has 0 Sepolia ETH — fund it first, then re-run.");
    process.exit(1);
  }

  // 1) Deploy the malicious spender (unverified, brand new).
  console.log("\nDeploying Spender contract...");
  const deployHash = await wallet.deployContract({ abi: [], bytecode: SPENDER_BYTECODE });
  const deployRc = await pub.waitForTransactionReceipt({ hash: deployHash });
  const spender = getAddress(deployRc.contractAddress);
  console.log("  Spender deployed:", spender, "(tx", deployHash + ")");

  // 2) approve(token, MAX) to the spender for each token.
  console.log("\nGranting unlimited approvals to the spender:");
  for (const sym of pick) {
    const token = getAddress(TOKENS[sym]);
    try {
      const hash = await wallet.writeContract({
        address: token,
        abi: ERC20,
        functionName: "approve",
        args: [spender, maxUint256],
      });
      await pub.waitForTransactionReceipt({ hash });
      console.log("  " + sym.padEnd(5), "MAX ->", spender, "tx", hash);
    } catch (e) {
      console.log("  " + sym.padEnd(5), "FAILED:", e.shortMessage || e.message);
    }
  }

  console.log("\nDone. Connect", account.address, "on Sepolia in Scam Slayer and scan.");
  console.log("Tip: set an Etherscan key (Settings/.env) so the spender scores as a threat");
  console.log("(unverified + brand-new = high risk). Revoke directly from the kill button.");
}

main().catch((e) => { console.error(e); process.exit(1); });

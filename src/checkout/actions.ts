/**
 * Action builders for Flow C — construct the Call[] batch that runs atomically
 * after FXRP is minted to the customer's smart account via
 * executeDirectMintingWithData.
 *
 * All builders are pure + offline: they produce Call structs (target/value/data)
 * without touching the chain. The executor bundles them into a PackedUserOperation.
 *
 * Security: calldata is built from typed parameters via ethers AbiCoder (no
 * hand-rolled byte packing). Target addresses are validated as 0x-prefixed 20-byte
 * values. XRPL memo bytes / FDC proof bytes never flow into these builders — only
 * the deterministic EVM call parameters do.
 *
 * Common Flow C actions (from the smart-accounts skill):
 *   - transferToMerchant: FXRP.transfer(merchantFlareAddress, amount) — atomic
 *     mint + route FXRP to the merchant's EOA (the merchant-checkout primitive).
 *   - depositToVault: vault.deposit(amount) — atomic mint + deposit to a yield
 *     vault (Firelight stXRP / Upshift). The vault address + calldata are supplied
 *     by the operator (the specific vault ABI is operator-specific).
 *   - swapExactInput: DEX exactInputSingle(...) — atomic mint + swap FXRP→USDT0.
 *
 * Ref: .agents/skills/flare-smart-accounts-skill/SKILL.md
 */

import { AbiCoder, id as ethersId } from "ethers";

export interface Call {
  target: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
}

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

function assertAddress(a: string, label: string): asserts a is `0x${string}` {
  if (!ADDR_RE.test(a)) throw new Error(`invalid ${label} address: ${a}`);
}

function encodeCall(selector: string, types: string[], args: unknown[]): `0x${string}` {
  const sig = `${selector}(${types.join(",")})`;
  const selectorHex = ethersId(sig).slice(0, 10) as `0x${string}`;
  const params = AbiCoder.defaultAbiCoder().encode(types, args) as `0x${string}`;
  return (selectorHex + params.slice(2)) as `0x${string}`;
}

/**
 * FXRP.transfer(recipient, amount) — move minted FXRP to the merchant's EOA.
 * The smart account holds the freshly-minted FXRP; this transfers it out.
 */
export function buildTransferCall(
  fxrpTokenAddress: `0x${string}`,
  recipient: `0x${string}`,
  amount: bigint,
): Call {
  assertAddress(fxrpTokenAddress, "fxrpTokenAddress");
  assertAddress(recipient, "recipient");
  if (amount <= 0n) throw new Error("transfer amount must be positive");
  return {
    target: fxrpTokenAddress,
    value: 0n,
    data: encodeCall("transfer", ["address", "uint256"], [recipient, amount]),
  };
}

/**
 * Generic vault deposit — vault.deposit(amount) (or similar). The operator supplies
 * the vault address + the deposit function selector/arg layout. We expose a thin
 * generic encoder so the plugin doesn't hardcode a specific vault ABI.
 */
export function buildVaultDepositCall(
  vaultAddress: `0x${string}`,
  amount: bigint,
  depositSelector = "deposit",
  extraArgTypes: string[] = [],
  extraArgs: unknown[] = [],
): Call {
  assertAddress(vaultAddress, "vaultAddress");
  if (amount <= 0n) throw new Error("deposit amount must be positive");
  const types = ["uint256", ...extraArgTypes];
  const args: unknown[] = [amount, ...extraArgs];
  return {
    target: vaultAddress,
    value: 0n,
    data: encodeCall(depositSelector, types, args),
  };
}

/**
 * Generic single-call action for any contract call the operator wants to run
 * atomically post-mint (e.g. a DEX swap with pre-encoded calldata).
 */
export function buildRawCall(
  target: `0x${string}`,
  data: `0x${string}`,
  value = 0n,
): Call {
  assertAddress(target, "target");
  if (!data.startsWith("0x")) throw new Error(`call data must be 0x-prefixed: ${data}`);
  if (value < 0n) throw new Error("value must be non-negative");
  return { target, value, data };
}

/**
 * Compose a batch of calls. The smart account executes them in order within the
 * atomic user op. All-or-nothing: if any call reverts, the whole mint rolls back.
 */
export function composeCalls(calls: Call[]): Call[] {
  if (calls.length === 0) throw new Error("composeCalls: empty batch");
  return [...calls];
}


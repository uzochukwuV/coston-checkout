/**
 * PackedUserOperation builder for Flow C (atomic mint + user op via
 * executeDirectMintingWithData).
 *
 * A Flare Smart Account's personal account exposes an EIP-4337-style
 * `executeUserOp(Call[])` entry point. A "custom instruction" (`0xFE`) commits
 * to a PackedUserOperation by hash in the 42-byte XRPL memo; the executor supplies
 * the full ABI-encoded `PackedUserOperation` as `_data` to
 * `AssetManager.executeDirectMintingWithData(proof, data)`. The contract verifies
 * `keccak256(data) == memoHash`, mints FXRP to the personal account, and dispatches
 * the user op — atomically. A revert rolls back the mint entirely.
 *
 * Only three fields are validated on-chain: `sender` (= personal account address),
 * `nonce` (= current memo nonce), and `callData` (= abi.encodeCall(executeUserOp, [calls])).
 * The remaining EIP-4337 fields are empty/zero (not validated by the smart-account
 * controller — there is no bundler/paymaster gas-pricing path here; the executor pays
 * FLR gas directly and recovers it via the executor fee).
 *
 * Pure + offline: no chain access, no key handling. Easy to unit-test.
 *
 * Ref: .agents/skills/flare-smart-accounts-skill/SKILL.md (Custom Instructions)
 */

import { AbiCoder, concat, dataSlice, id as ethersId, keccak256, zeroPadValue } from "ethers";

/** A single EVM call inside a user operation. */
export interface Call {
  target: `0x${string}`;
  value: bigint; // FLR (wei) to send with the call; 0 for plain ERC-20 ops
  data: `0x${string}`; // ABI-encoded calldata
}

/**
 * Minimal PackedUserOperation. The smart-account controller only enforces
 * sender / nonce / callData; the rest are placeholders for EIP-4337 shape parity.
 */
export interface PackedUserOperation {
  sender: `0x${string}`;
  nonce: bigint;
  callData: `0x${string}`;
  initCode: `0x${string}`;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  gasFees: `0x${string}`; // packed maxFeePerGas + maxPriorityFeePerGas (unused)
  paymasterAndData: `0x${string}`; // "0x" — no paymaster; executor pays gas
  signature: `0x${string}`; // "0x" — XRPL source authorizes via the FDC proof
}

/** ABI signature of the personal-account entry point (for callData encoding). */
export const EXECUTE_USEROP_SELECTOR = "executeUserOp((address,uint256,bytes)[])";

/**
 * Build a PackedUserOperation. The caller supplies the resolved personal-account
 * address (sender) + current memo nonce + the call batch.
 */
export function buildUserOp(
  sender: `0x${string}`,
  nonce: bigint,
  calls: Call[],
): PackedUserOperation {
  if (!/^0x[a-fA-F0-9]{40}$/.test(sender)) {
    throw new Error(`invalid sender address: ${sender}`);
  }
  if (nonce < 0n) throw new Error("nonce must be non-negative");
  if (calls.length === 0) throw new Error("user op requires at least one call");
  for (const c of calls) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(c.target)) {
      throw new Error(`invalid call target: ${c.target}`);
    }
    if (!c.data.startsWith("0x")) throw new Error(`call data must be 0x-prefixed: ${c.data}`);
  }
  const callData = encodeExecuteUserOpCallData(calls);
  return {
    sender,
    nonce,
    callData,
    initCode: "0x",
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    gasFees: "0x",
    paymasterAndData: "0x",
    signature: "0x",
  };
}

/**
 * ABI-encode the PackedUserOperation as bytes (the `_data` argument to
 * executeDirectMintingWithData). Uses the EIP-4337 tuple order; the smart-account
 * controller decodes this and checks keccak256(result) against the 0xFE memo hash.
 */
export function abiEncodeUserOp(op: PackedUserOperation): `0x${string}` {
  const tuple = [
    op.sender,
    op.nonce,
    op.callData,
    op.initCode,
    op.callGasLimit,
    op.verificationGasLimit,
    op.preVerificationGas,
    op.gasFees,
    op.paymasterAndData,
    op.signature,
  ];
  // ethers v6 AbiCoder.encode returns hex string
  return AbiCoder.defaultAbiCoder().encode(
    [
      "address", "uint256", "bytes", "bytes", "uint256", "uint256", "uint256", "bytes", "bytes", "bytes",
    ],
    tuple,
  ) as `0x${string}`;
}

/** keccak256 of the ABI-encoded user op — this goes in the 0xFE memo (bytes 10-41). */
export function userOpHash(op: PackedUserOperation): `0x${string}` {
  return keccak256(abiEncodeUserOp(op)) as `0x${string}`;
}

/** Total FLR value the executor must attach as msg.value (= sum of call.value). */
export function totalCallValue(calls: Call[]): bigint {
  return calls.reduce((sum, c) => sum + c.value, 0n);
}

// -- internals -------------------------------------------------------------

/**
 * Encode callData = abi.encodeCall(IPersonalAccount.executeUserOp, [calls]).
 * The Call struct is (address target, uint256 value, bytes data).
 */
function encodeExecuteUserOpCallData(calls: Call[]): `0x${string}` {
  // Encode as executeUserOp((address,uint256,bytes)[]) → the calls array is a tuple array.
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["tuple(address target, uint256 value, bytes data)[]"],
    [calls.map((c) => ({ target: c.target, value: c.value, data: c.data }))],
  ) as `0x${string}`;
  return encoded;
}

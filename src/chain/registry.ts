/**
 * Resolve Flare contract addresses at runtime from FlareContractsRegistry.
 *
 * Skill guardrail: NEVER hardcode AssetManager/FXRP/etc addresses — they differ
 * per network (Coston2, Songbird, Flare mainnet). The registry address below is
 * the same on all Flare networks; verify at:
 *   https://dev.flare.network/network/guides/flare-contracts-registry
 */
import { Contract, JsonRpcProvider } from "ethers";

export const FLARE_CONTRACTS_REGISTRY_ADDRESS =
  "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019" as const;

const REGISTRY_ABI = [
  "function getContractAddressByName(string) view returns (address)",
  "function getAllContracts() view returns (tuple(bytes32 name, address contractAddress)[])",
];

export interface ResolvedAddresses {
  registry: string;
  assetManagerFXRP: string;
  fxrpToken: string;
  fdcHub: string;
  fdcRequestFeeConfigurations: string;
  relay: string;
  flareSystemsManager: string;
}

export async function resolveAddresses(rpcUrl: string): Promise<ResolvedAddresses> {
  const provider = new JsonRpcProvider(rpcUrl);
  const registry = new Contract(FLARE_CONTRACTS_REGISTRY_ADDRESS, REGISTRY_ABI, provider);
  const assetManagerFXRP = (await registry.getContractAddressByName("AssetManagerFXRP")) as string;

  // AssetManager.fAsset() returns the FXRP ERC-20 token address
  const assetManager = new Contract(
    assetManagerFXRP,
    ["function fAsset() view returns (address)"],
    provider,
  );
  const fxrpToken = (await assetManager.fAsset()) as string;

  const [fdcHub, fdcRequestFeeConfigurations, relay, flareSystemsManager] = await Promise.all([
    registry.getContractAddressByName("FdcHub"),
    registry.getContractAddressByName("FdcRequestFeeConfigurations"),
    registry.getContractAddressByName("Relay"),
    registry.getContractAddressByName("FlareSystemsManager"),
  ]);

  return {
    registry: FLARE_CONTRACTS_REGISTRY_ADDRESS,
    assetManagerFXRP,
    fxrpToken,
    fdcHub,
    fdcRequestFeeConfigurations,
    relay,
    flareSystemsManager,
  };
}

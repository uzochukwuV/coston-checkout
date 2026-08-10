/**
 * Read-only AssetManager (FXRP) client — live fee params, Core Vault address,
 * MintingTagManager, rate limits.
 *
 * All values are read live from the chain at runtime. Skill guardrail:
 * Coston2 values shown in skills must NOT be hardcoded for mainnet.
 */
import { Contract, JsonRpcProvider } from "ethers";

const ASSET_MANAGER_ABI = [
  "function directMintingPaymentAddress() view returns (string)",
  "function getDirectMintingMinimumFeeUBA() view returns (uint256)",
  "function getDirectMintingFeeBIPS() view returns (uint256)",
  "function getDirectMintingExecutorFeeUBA() view returns (uint256)",
  "function getDirectMintingOthersCanExecuteAfterSeconds() view returns (uint256)",
  "function getDirectMintingHourlyLimitUBA() view returns (uint256)",
  "function getDirectMintingDailyLimitUBA() view returns (uint256)",
  "function getMintingTagManager() view returns (address)",
  "function fAsset() view returns (address)",
  "function redeemWithTagSupported() view returns (bool)",
  // Redemption fee params (Phase 2)
  "function minimumRedeemAmountUBA() view returns (uint256)",
  "function getCoreVaultRedemptionFeeBIPS() view returns (uint256)",
  "function getCoreVaultMinimumRedeemLots() view returns (uint256)",
];

export interface DirectMintingParams {
  coreVaultXrplAddress: string;
  minimumFeeUBA: bigint;
  feeBIPS: bigint;
  executorFeeUBA: bigint;
  othersCanExecuteAfterSeconds: bigint;
  hourlyLimitUBA: bigint;
  dailyLimitUBA: bigint;
  mintingTagManager: string;
  redeemWithTagSupported: boolean;
}

export interface RedemptionParams {
  minimumRedeemAmountUBA: bigint;
  redemptionFeeBIPS: bigint;
  minimumRedeemLots: bigint;
}

/** Combined fee parameters used by the pricing module. */
export interface FeeParams {
  // minting
  mintFeeBIPS: bigint;
  mintMinimumFeeUBA: bigint;
  executorFeeUBA: bigint;
  // redemption
  redeemFeeBIPS: bigint;
  minimumRedeemAmountUBA: bigint;
}

export class AssetManagerClient {
  private contract: Contract;

  constructor(assetManagerAddress: string, provider: JsonRpcProvider) {
    this.contract = new Contract(assetManagerAddress, ASSET_MANAGER_ABI, provider);
  }

  static fromRpc(assetManagerAddress: string, rpcUrl: string): AssetManagerClient {
    return new AssetManagerClient(assetManagerAddress, new JsonRpcProvider(rpcUrl));
  }

  async getDirectMintingParams(): Promise<DirectMintingParams> {
    const [
      coreVaultXrplAddress,
      minimumFeeUBA,
      feeBIPS,
      executorFeeUBA,
      othersCanExecuteAfterSeconds,
      hourlyLimitUBA,
      dailyLimitUBA,
      mintingTagManager,
      redeemWithTagSupported,
    ] = await Promise.all([
      this.contract.directMintingPaymentAddress(),
      this.contract.getDirectMintingMinimumFeeUBA(),
      this.contract.getDirectMintingFeeBIPS(),
      this.contract.getDirectMintingExecutorFeeUBA(),
      this.contract.getDirectMintingOthersCanExecuteAfterSeconds(),
      this.contract.getDirectMintingHourlyLimitUBA(),
      this.contract.getDirectMintingDailyLimitUBA(),
      this.contract.getMintingTagManager(),
      this.contract.redeemWithTagSupported(),
    ]);

    return {
      coreVaultXrplAddress,
      minimumFeeUBA,
      feeBIPS,
      executorFeeUBA,
      othersCanExecuteAfterSeconds,
      hourlyLimitUBA,
      dailyLimitUBA,
      mintingTagManager,
      redeemWithTagSupported,
    };
  }

  async getRedemptionParams(): Promise<RedemptionParams> {
    const [minimumRedeemAmountUBA, redemptionFeeBIPS, minimumRedeemLots] = await Promise.all([
      this.contract.minimumRedeemAmountUBA(),
      this.contract.getCoreVaultRedemptionFeeBIPS(),
      this.contract.getCoreVaultMinimumRedeemLots(),
    ]);
    return { minimumRedeemAmountUBA, redemptionFeeBIPS, minimumRedeemLots };
  }

  /** Combined fee params for the pricing module (mint + redeem). */
  async getFeeParams(): Promise<FeeParams> {
    const [mint, redeem] = await Promise.all([
      this.getDirectMintingParams(),
      this.getRedemptionParams(),
    ]);
    return {
      mintFeeBIPS: mint.feeBIPS,
      mintMinimumFeeUBA: mint.minimumFeeUBA,
      executorFeeUBA: mint.executorFeeUBA,
      redeemFeeBIPS: redeem.redemptionFeeBIPS,
      minimumRedeemAmountUBA: redeem.minimumRedeemAmountUBA,
    };
  }
}

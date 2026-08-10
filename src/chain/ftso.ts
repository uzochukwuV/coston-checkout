/**
 * Read-only FTSO client — XRP/USD and FLR/USD price feeds.
 *
 * Feed IDs from the skill (hex-encoded, 21 bytes = 42 hex chars):
 *   XRP/USD: 0x015852502f55534400000000000000000000000000  ("XR...P/USD")
 *   FLR/USD: 0x01464c522f55534400000000000000000000000000  ("FLR/USD")
 *
 * Resolve FtsoV2 via FlareContractsRegistry at runtime.
 */
import { Contract, JsonRpcProvider } from "ethers";
import { FLARE_CONTRACTS_REGISTRY_ADDRESS } from "./registry.js";

const REGISTRY_ABI = [
  "function getContractAddressByName(string) view returns (address)",
  // Testnet exposes a free (no-fee) view interface via getTestFtsoV2.
  "function getTestFtsoV2() view returns (address)",
];

// FtsoV2Interface.getFeedById returns (uint256 value, int8 decimals, uint64 timestamp).
// getFeedByIdInWei returns (uint256 value, uint64 timestamp).
const FTSO_ABI = [
  "function getFeedById(bytes21 _feedId) view returns (uint256 value, int8 decimals, uint64 timestamp)",
  "function getFeedByIdInWei(bytes21 _feedId) view returns (uint256 value, uint64 timestamp)",
];

export const XRP_USD_FEED_ID = "0x015852502f55534400000000000000000000000000" as const;
export const FLR_USD_FEED_ID = "0x01464c522f55534400000000000000000000000000" as const;

export interface FeedResult {
  value: bigint;
  decimals: number;
  timestamp: number;
  /** Stale if older than MAX_FEED_AGE_SECONDS. */
  stale: boolean;
}

const MAX_FEED_AGE_SECONDS = 3600; // 1 hour — reject prices older than this for checkout quotes

export class FtsoClient {
  private ftso: Contract;

  private constructor(ftsoAddress: string, provider: JsonRpcProvider) {
    this.ftso = new Contract(ftsoAddress, FTSO_ABI, provider);
  }

  static async create(rpcUrl: string): Promise<FtsoClient> {
    const provider = new JsonRpcProvider(rpcUrl);
    const registry = new Contract(FLARE_CONTRACTS_REGISTRY_ADDRESS, REGISTRY_ABI, provider);
    // On Coston2 (testnet) prefer the free view interface; fall back to the named FtsoV2.
    let ftsoAddress: string;
    try {
      ftsoAddress = (await registry.getTestFtsoV2()) as string;
    } catch {
      ftsoAddress = (await registry.getContractAddressByName("FtsoV2")) as string;
    }
    return new FtsoClient(ftsoAddress, provider);
  }

  async getFeed(feedId: string): Promise<FeedResult> {
    const [value, decimals, timestamp] = await this.ftso.getFeedById(feedId);
    const nowSec = Math.floor(Date.now() / 1000);
    const age = nowSec - Number(timestamp);
    return {
      value: value as bigint,
      decimals: Number(decimals),
      timestamp: Number(timestamp),
      stale: age > MAX_FEED_AGE_SECONDS,
    };
  }

  /** Human-readable price as a JS number (use for display only, not for on-chain amounts). */
  static toDisplayPrice(result: FeedResult): number {
    return Number(result.value) / 10 ** result.decimals;
  }

  /** Compute the XRP amount (in drops) for a USD amount given the XRP/USD feed. */
  static xrpAmountDrops(usdAmount: number, xrpUsd: FeedResult): bigint {
    // xrpUsd.value has `decimals` precision. xrpAmount = usd / price.
    const priceScaled = xrpUsd.value;
    const usdScaled = BigInt(Math.round(usdAmount * 10 ** xrpUsd.decimals));
    // drops = (usdScaled * 1e6) / priceScaled   (1 XRP = 1e6 drops)
    const drops = (usdScaled * 1_000_000n) / priceScaled;
    return drops;
  }
}

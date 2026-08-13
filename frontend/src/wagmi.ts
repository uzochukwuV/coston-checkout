/**
 * wagmi config — Coston2 chain, injected() connector.
 * The Flare skills recommend wagmi + viem + @flarenetwork/flare-wagmi-periphery-package.
 * We inline the Coston2 chain config (no extra package dependency) since our
 * on-chain reads are minimal (merchant FXRP balance, settle tx links).
 */

import { http, createConfig, createStorage } from "wagmi";
import { injected } from "wagmi/connectors";
import { cookieStorage } from "wagmi";

/** Coston2 (Flare dApp testnet) — chain ID 114. */
const coston2 = {
  id: 114,
  name: "Coston2",
  nativeCurrency: { name: "C2FLR", symbol: "C2FLR", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://coston2-api.flare.network/ext/bc/C/rpc"] },
  },
  blockExplorers: {
    default: { name: "Coston2 Explorer", url: "https://coston2-explorer.flare.network" },
  },
  testnet: true,
} as const;

export const config = createConfig({
  chains: [coston2],
  connectors: [injected()],
  storage: createStorage({ storage: cookieStorage }),
  ssr: false,
  transports: {
    [coston2.id]: http("https://coston2-api.flare.network/ext/bc/C/rpc"),
  },
});

export { coston2 };

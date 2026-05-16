import { createDAppKit } from "@mysten/dapp-kit-core";
import { SuiGrpcClient } from "@mysten/sui/grpc";

const BASE_URLS: Record<string, string> = {
  testnet: "https://sui-testnet.mystenlabs.com",
  mainnet: "https://sui-mainnet.mystenlabs.com",
};

let _instance: ReturnType<typeof createInstance> | null = null;

function createInstance() {
  return createDAppKit({
    networks: ["testnet", "mainnet"] as const,
    defaultNetwork: "testnet" as const,
    createClient: (network) =>
      new SuiGrpcClient({ network, baseUrl: BASE_URLS[network] }),
    autoConnect: true,
  });
}

export function getDAppKit() {
  if (!_instance) {
    _instance = createInstance();
  }
  return _instance;
}

declare module "@mysten/dapp-kit-react" {
  interface Register {
    dAppKit: ReturnType<typeof createInstance>;
  }
}

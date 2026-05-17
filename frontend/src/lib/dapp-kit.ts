import { createDAppKit } from "@mysten/dapp-kit-core";
import { SuiGrpcClient } from "@mysten/sui/grpc";

let _instance: ReturnType<typeof createInstance> | null = null;

function createInstance() {
  return createDAppKit({
    networks: ["testnet", "mainnet"] as const,
    defaultNetwork: "testnet" as const,
    createClient: (network) =>
      new SuiGrpcClient({
        network,
        baseUrl: network === "mainnet"
          ? "https://fullnode.mainnet.sui.io:443"
          : "https://fullnode.testnet.sui.io:443",
      }),
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

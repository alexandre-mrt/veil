import { createDAppKit } from "@mysten/dapp-kit-core";

let _instance: any = null;
let _initPromise: Promise<any> | null = null;

async function createInstance() {
  const { SuiGrpcClient } = await import("@mysten/sui/grpc");
  return createDAppKit({
    networks: ["testnet", "mainnet"] as const,
    defaultNetwork: "testnet" as const,
    createClient: (network) =>
      new SuiGrpcClient({
        network,
        baseUrl: network === "mainnet"
          ? "https://sui-mainnet.mystenlabs.com"
          : "https://sui-testnet.mystenlabs.com",
      }),
    autoConnect: true,
  });
}

export async function getDAppKitAsync() {
  if (_instance) return _instance;
  if (!_initPromise) _initPromise = createInstance();
  _instance = await _initPromise;
  return _instance;
}

export function getDAppKit() {
  if (!_instance) throw new Error("DAppKit not initialized — call getDAppKitAsync first");
  return _instance;
}

declare module "@mysten/dapp-kit-react" {
  interface Register {
    dAppKit: any;
  }
}

"use client";

import { type ReactNode, useEffect, useState } from "react";

export function Providers({ children }: { children: ReactNode }) {
  const [Provider, setProvider] = useState<React.ComponentType<{ children: ReactNode }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [{ createDAppKit }, { SuiGrpcClient }, { DAppKitProvider }] = await Promise.all([
          import("@mysten/dapp-kit-core"),
          import("@mysten/sui/grpc"),
          import("@mysten/dapp-kit-react"),
        ]);

        const dAppKit = createDAppKit({
          networks: ["testnet", "mainnet"] as const,
          defaultNetwork: "testnet" as const,
          createClient: (network: string) =>
            new SuiGrpcClient({
              network: network as "testnet" | "mainnet",
              baseUrl: network === "mainnet"
                ? "https://sui-mainnet.mystenlabs.com"
                : "https://sui-testnet.mystenlabs.com",
            }),
          autoConnect: true,
        });

        setProvider(() =>
          function Wrapper({ children: c }: { children: ReactNode }) {
            return <DAppKitProvider dAppKit={dAppKit}>{c}</DAppKitProvider>;
          }
        );
      } catch (e) {
        console.error("SDK init failed:", e);
        setError(e instanceof Error ? e.message : "Failed to initialize wallet SDK");
      }
    })();
  }, []);

  if (error) {
    return (
      <div style={{ padding: 40, color: "#ff4444", fontFamily: "JetBrains Mono, monospace", background: "#0a0a0a", minHeight: "100vh" }}>
        <h2 style={{ color: "#e0e0e0", marginBottom: 16 }}>Wallet SDK Error</h2>
        <pre style={{ color: "#808080", fontSize: 12 }}>{error}</pre>
        <p style={{ color: "#808080", marginTop: 16 }}>Try refreshing or using a different browser.</p>
      </div>
    );
  }

  if (!Provider) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "#0a0a0a", color: "#00ff88", fontFamily: "JetBrains Mono, monospace", fontSize: 14 }}>
        Initializing wallet SDK...
      </div>
    );
  }

  return <Provider>{children}</Provider>;
}

"use client";

import { DAppKitProvider } from "@mysten/dapp-kit-react";
import { getDAppKit } from "@/lib/dapp-kit";
import { type ReactNode, useEffect, useState } from "react";

export function Providers({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      getDAppKit();
      setReady(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to initialize wallet SDK");
    }
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

  if (!ready) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "#0a0a0a", color: "#00ff88", fontFamily: "JetBrains Mono, monospace" }}>
        Loading...
      </div>
    );
  }

  const dAppKit = getDAppKit();
  return <DAppKitProvider dAppKit={dAppKit}>{children}</DAppKitProvider>;
}

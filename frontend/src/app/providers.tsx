"use client";

import { type ReactNode, useEffect, useState } from "react";

export function Providers({ children }: { children: ReactNode }) {
  const [Wrapper, setWrapper] = useState<React.ComponentType<{ children: ReactNode }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { getDAppKitAsync } = await import("@/lib/dapp-kit");
        const dAppKit = await getDAppKitAsync();
        const { DAppKitProvider } = await import("@mysten/dapp-kit-react");
        if (cancelled) return;
        setWrapper(() => function W({ children: c }: { children: ReactNode }) {
          return <DAppKitProvider dAppKit={dAppKit}>{c}</DAppKitProvider>;
        });
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "SDK initialization failed");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <div style={{
        padding: 40, color: "#e0e0e0", fontFamily: "JetBrains Mono, monospace",
        background: "#0a0a0a", minHeight: "100vh",
      }}>
        <h1 style={{ color: "#00ff88", fontSize: "2rem", marginBottom: 24 }}>VEIL</h1>
        <h2 style={{ color: "#ff4444", marginBottom: 16, fontSize: "0.9rem" }}>SDK Error</h2>
        <pre style={{ color: "#808080", fontSize: 11, padding: 16, background: "#141414", border: "1px solid #1f1f1f" }}>{error}</pre>
        <p style={{ color: "#808080", fontSize: 12, marginTop: 16 }}>
          <a href="/" style={{ color: "#00ff88" }}>Back to home</a>
          {" | "}
          <button onClick={() => window.location.reload()}
            style={{ color: "#00ff88", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}>
            Retry
          </button>
        </p>
      </div>
    );
  }

  if (!Wrapper) {
    return (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        minHeight: "100vh", background: "#0a0a0a", color: "#00ff88",
        fontFamily: "JetBrains Mono, monospace", fontSize: 14,
      }}>
        Initializing...
      </div>
    );
  }

  return <Wrapper>{children}</Wrapper>;
}

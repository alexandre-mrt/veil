"use client";

import { DAppKitProvider } from "@mysten/dapp-kit-react";
import { getDAppKit } from "@/lib/dapp-kit";
import { type ReactNode, Component } from "react";

class ProviderErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 40, color: "#e0e0e0",
          fontFamily: "JetBrains Mono, monospace",
          background: "#0a0a0a", minHeight: "100vh",
        }}>
          <h1 style={{ color: "#00ff88", fontSize: "2rem", marginBottom: 24 }}>VEIL</h1>
          <h2 style={{ color: "#ff4444", marginBottom: 16, fontSize: "0.9rem" }}>
            Wallet SDK Error
          </h2>
          <pre style={{
            color: "#808080", fontSize: 11, padding: 16,
            background: "#141414", border: "1px solid #1f1f1f",
            overflow: "auto", marginBottom: 24,
          }}>
            {this.state.error.message}
          </pre>
          <p style={{ color: "#808080", fontSize: 12 }}>
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
    return this.props.children;
  }
}

export function Providers({ children }: { children: ReactNode }) {
  const dAppKit = getDAppKit();
  return (
    <ProviderErrorBoundary>
      <DAppKitProvider dAppKit={dAppKit}>{children}</DAppKitProvider>
    </ProviderErrorBoundary>
  );
}

"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const DashboardContent = dynamic(() => import("./DashboardContent"), {
  ssr: false,
  loading: () => (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      minHeight: "100vh", background: "#0a0a0a", color: "#00ff88",
      fontFamily: "JetBrains Mono, monospace", fontSize: 14,
    }}>
      Loading dashboard...
    </div>
  ),
});

export default function DashboardPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: ErrorEvent) => {
      setError(e.message || "Unknown error during initialization");
    };
    const rejectionHandler = (e: PromiseRejectionEvent) => {
      setError(e.reason?.message || String(e.reason) || "Promise rejection during initialization");
    };
    window.addEventListener("error", handler);
    window.addEventListener("unhandledrejection", rejectionHandler);
    return () => {
      window.removeEventListener("error", handler);
      window.removeEventListener("unhandledrejection", rejectionHandler);
    };
  }, []);

  if (error) {
    return (
      <div style={{
        padding: 40, color: "#e0e0e0",
        fontFamily: "JetBrains Mono, monospace",
        background: "#0a0a0a", minHeight: "100vh",
      }}>
        <h1 style={{ color: "#00ff88", fontSize: "2rem", marginBottom: 24 }}>VEIL</h1>
        <h2 style={{ color: "#ff4444", marginBottom: 16, fontSize: "0.9rem" }}>
          Dashboard initialization failed
        </h2>
        <pre style={{
          color: "#808080", fontSize: 11, padding: 16,
          background: "#141414", border: "1px solid #1f1f1f",
          borderRadius: 2, overflow: "auto", marginBottom: 24,
        }}>
          {error}
        </pre>
        <p style={{ color: "#808080", fontSize: 12, lineHeight: 1.8 }}>
          This usually means the Sui wallet SDK failed to connect.
          <br />Make sure you have a Sui wallet extension installed (Sui Wallet, Suiet, etc.).
          <br /><br />
          <a href="/" style={{ color: "#00ff88" }}>Back to home</a>
          {" | "}
          <button
            onClick={() => window.location.reload()}
            style={{
              color: "#00ff88", background: "none", border: "none",
              cursor: "pointer", fontFamily: "inherit", fontSize: "inherit",
              textDecoration: "underline",
            }}
          >
            Retry
          </button>
        </p>
      </div>
    );
  }

  return <DashboardContent />;
}

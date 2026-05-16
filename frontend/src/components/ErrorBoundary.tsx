"use client";

import { Component, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
}

interface ErrorBoundaryState {
  readonly hasError: boolean;
  readonly error: Error | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * React error boundary that catches render errors in the subtree
 * and displays a recoverable fallback UI.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          style={{
            padding: 24,
            color: "#ff4444",
            fontFamily: "'JetBrains Mono', monospace",
            backgroundColor: "rgba(255, 68, 68, 0.05)",
            border: "1px solid #ff4444",
            borderRadius: 4,
          }}
        >
          <h2 style={{ fontSize: 14, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" as const, margin: 0 }}>
            Something went wrong
          </h2>
          <pre
            style={{
              fontSize: 12,
              color: "#808080",
              marginTop: 8,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {this.state.error?.message}
          </pre>
          <button
            type="button"
            onClick={this.handleReset}
            style={{
              marginTop: 12,
              padding: "8px 16px",
              border: "1px solid #ff4444",
              background: "transparent",
              color: "#ff4444",
              cursor: "pointer",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase" as const,
              borderRadius: 4,
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

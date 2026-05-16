"use client";

import { DAppKitProvider } from "@mysten/dapp-kit-react";
import { getDAppKit } from "@/lib/dapp-kit";
import type { ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  const dAppKit = getDAppKit();
  return <DAppKitProvider dAppKit={dAppKit}>{children}</DAppKitProvider>;
}

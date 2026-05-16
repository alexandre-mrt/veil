// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

/** Returns env var value. In production, throws if missing and no fallback. */
function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const isDev = process.env.NODE_ENV === "development";

// ---------------------------------------------------------------------------
// Network & contract addresses
// ---------------------------------------------------------------------------

export const NETWORK = requireEnv(
  "NEXT_PUBLIC_NETWORK",
  "testnet",
) as "testnet" | "mainnet";

export const PACKAGE_ID = requireEnv(
  "NEXT_PUBLIC_PACKAGE_ID",
  "0x5cd79f85f1adca022513d76c60d557f8b17afed91f741d14016c7a23cab6c228",
);

export const POOL_ID = requireEnv(
  "NEXT_PUBLIC_POOL_ID",
  "0x6ba8019987c7c5d02d2c2b11e0eddd491428d0cc6bbed05ab79760e069ce913a",
);

export const TREASURY_CAP_ID = requireEnv(
  "NEXT_PUBLIC_TREASURY_CAP_ID",
  "0xdc0f16084cbd2d33d1fc3630e80bac565469550e93c5e147a7d9c04fa4a3058f",
);

export const ADMIN_CAP_ID = requireEnv(
  "NEXT_PUBLIC_ADMIN_CAP_ID",
  "0x038754ce782a7670884961335a7d7e50215a4793d2c44dde208c2527eeed28d4",
);

export const TOKEN_TYPE = `${PACKAGE_ID}::token::TOKEN`;

export const THRESHOLD = BigInt(requireEnv("NEXT_PUBLIC_THRESHOLD", "1000000000")); // 1000 VEIL (6 decimals)

// Epoch duration: 1h for testnet, 30 days for production (2_592_000_000)
export const EPOCH_DURATION_MS = Number(requireEnv("NEXT_PUBLIC_EPOCH_DURATION_MS", "3600000"));

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export const REFETCH_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export const VEIL_DECIMALS = 6;
export const EXPLORER_TX_URL = `https://suiscan.xyz/${NETWORK}/tx`;

// ---------------------------------------------------------------------------
// Compliance (Tier 3)
// ---------------------------------------------------------------------------

export const COMPLIANCE_CONFIG_ID = requireEnv(
  "NEXT_PUBLIC_COMPLIANCE_CONFIG_ID",
  "0xa6c92b963d9b67896416ae2eb23f0fadbbc62e90fba6ca18db5f96b6bc4f63c7",
);

export const REQUIRED_KYC_LEVEL = 1;

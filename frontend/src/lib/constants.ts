export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? "testnet") as "testnet" | "mainnet";
export const PACKAGE_ID = process.env.NEXT_PUBLIC_PACKAGE_ID ?? "0x0245e6036e5bddec129ebab477cd58f5d3b82eeb965389413340e6f8068739df";
export const POOL_ID = process.env.NEXT_PUBLIC_POOL_ID ?? "0xe3ffa82ca5da9551d8c5dd0b47e642e757f764fa8cf233ae6d73ee9fae1f6442";
export const TREASURY_CAP_ID = process.env.NEXT_PUBLIC_TREASURY_CAP_ID ?? "0xbc840bb5fb4a3848eda07a022480d19e3532b94ba81cdba823b968c955d9e8f0";
export const ADMIN_CAP_ID = process.env.NEXT_PUBLIC_ADMIN_CAP_ID ?? "0x5ec96ea6b8a04f7cf7cdef299d7c0d1174fbedb5cf6772c67dd86e7f954e9f1f";
export const TOKEN_TYPE = `${PACKAGE_ID}::token::TOKEN`;
export const THRESHOLD = BigInt(process.env.NEXT_PUBLIC_THRESHOLD ?? "1000000000"); // 1000 VEIL (6 decimals)
// Epoch duration: 1h for testnet, 30 days for production (2_592_000_000)
export const EPOCH_DURATION_MS = Number(process.env.NEXT_PUBLIC_EPOCH_DURATION_MS ?? "3600000");

// Polling
export const REFETCH_INTERVAL_MS = 10_000;

// Display
export const VEIL_DECIMALS = 6;
export const EXPLORER_TX_URL = `https://suiscan.xyz/${NETWORK}/tx`;

// Compliance (Tier 3)
export const COMPLIANCE_CONFIG_ID = process.env.NEXT_PUBLIC_COMPLIANCE_CONFIG_ID ?? "0xb65a3e42f13a5b33797940778ab7a2786209f0c280ba7c91830961d742023e14";
export const REQUIRED_KYC_LEVEL = 1;

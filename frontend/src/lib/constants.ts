export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? "testnet") as "testnet" | "mainnet";
export const PACKAGE_ID = process.env.NEXT_PUBLIC_PACKAGE_ID ?? "0x841b0e73000041583fe2ac312ab56aacdd0987e728bb4661270c01050d1d62d9";
export const POOL_ID = process.env.NEXT_PUBLIC_POOL_ID ?? "0x039c135c5599c1fe0ee15167ee3a14fb83604400b8b5ced59ff27aca5be162a1";
export const TREASURY_CAP_ID = process.env.NEXT_PUBLIC_TREASURY_CAP_ID ?? "0x3b2bf06ca265b4fac589045992f7604b31c92f37b769fcf60ba6a97978a28d4e";
export const ADMIN_CAP_ID = process.env.NEXT_PUBLIC_ADMIN_CAP_ID ?? "0x29bfa8bd9cf927f6bb88e247b09a0a5c8d3c1c040553557cc4aebb7bceba2201";
export const TOKEN_TYPE = `${PACKAGE_ID}::token::TOKEN`;
export const THRESHOLD = BigInt(process.env.NEXT_PUBLIC_THRESHOLD ?? "1000000000"); // 1000 VEIL (6 decimals)
export const EPOCH_DURATION_MS = Number(process.env.NEXT_PUBLIC_EPOCH_DURATION_MS ?? "3600000"); // 1h testnet

// Display
export const VEIL_DECIMALS = 6;
export const EXPLORER_TX_URL = `https://suiscan.xyz/${NETWORK}/tx`;

// Compliance (Tier 3)
export const COMPLIANCE_CONFIG_ID = process.env.NEXT_PUBLIC_COMPLIANCE_CONFIG_ID ?? "0xc37468e450141b34fb8b680d6c195a01de4f50e1af42f1a24ef30d1b200f3708";
export const REQUIRED_KYC_LEVEL = 1;

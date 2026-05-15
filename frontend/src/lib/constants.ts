export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? "testnet") as "testnet" | "mainnet";
export const PACKAGE_ID = process.env.NEXT_PUBLIC_PACKAGE_ID ?? "0x2cacdf4d2502f3870497bef4952bbb6f9646b4db03e446cfaa2e03d333b1c581";
export const POOL_ID = process.env.NEXT_PUBLIC_POOL_ID ?? "0x867d3cc126ca82366c6f05e4dffa61bbb18d780b82f1ce35adba95695f2e856f";
export const TREASURY_CAP_ID = process.env.NEXT_PUBLIC_TREASURY_CAP_ID ?? "0x1a4570f7b66e93d87d696795686d915de35d9b069b0b4cf95bac7b3c5fef8b83";
export const ADMIN_CAP_ID = process.env.NEXT_PUBLIC_ADMIN_CAP_ID ?? "0xd154d5f8ff253a807398fb6daf84455cf2f0c5c8212adcd4ff2dfac4d892c106";
export const TOKEN_TYPE = `${PACKAGE_ID}::token::TOKEN`;
export const THRESHOLD = BigInt(process.env.NEXT_PUBLIC_THRESHOLD ?? "1000000000"); // 1000 VEIL (6 decimals)
export const EPOCH_DURATION_MS = Number(process.env.NEXT_PUBLIC_EPOCH_DURATION_MS ?? "3600000"); // 1h testnet

// Display
export const VEIL_DECIMALS = 6;
export const EXPLORER_TX_URL = `https://suiscan.xyz/${NETWORK}/tx`;

// Compliance (Tier 3)
export const COMPLIANCE_CONFIG_ID = process.env.NEXT_PUBLIC_COMPLIANCE_CONFIG_ID ?? "0xa01f5a2b89f38d8b4011c7abb6299a51dedd1bda977e0c5c14c52922b16d0859";
export const REQUIRED_KYC_LEVEL = 1;

export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? "testnet") as "testnet" | "mainnet";
export const PACKAGE_ID = process.env.NEXT_PUBLIC_PACKAGE_ID ?? "0x2ae5b08fb18fd807ae79f8534b37f1c6c5b15b77f776a682db9d9ed2c45c7269";
export const POOL_ID = process.env.NEXT_PUBLIC_POOL_ID ?? "0x7b0d826642fc09ba85c1d665017cf27469a95c88562d2f843d12b8418324d73f";
export const TREASURY_CAP_ID = process.env.NEXT_PUBLIC_TREASURY_CAP_ID ?? "0x0f0dc85bf3b7c57c7203022ecf7f73a29669c914a3a55b8becc5c6045620f19c";
export const ADMIN_CAP_ID = process.env.NEXT_PUBLIC_ADMIN_CAP_ID ?? "0x8f345f76f3735c40dba5bbf282b0627852d74f0c31336b04bc846097fcfcce57";
export const TOKEN_TYPE = `${PACKAGE_ID}::token::TOKEN`;
export const THRESHOLD = BigInt(process.env.NEXT_PUBLIC_THRESHOLD ?? "1000000000"); // 1000 VEIL (6 decimals)
export const EPOCH_DURATION_MS = Number(process.env.NEXT_PUBLIC_EPOCH_DURATION_MS ?? "3600000"); // 1h testnet

// Polling
export const REFETCH_INTERVAL_MS = 10_000;

// Display
export const VEIL_DECIMALS = 6;
export const EXPLORER_TX_URL = `https://suiscan.xyz/${NETWORK}/tx`;

// Compliance (Tier 3)
export const COMPLIANCE_CONFIG_ID = process.env.NEXT_PUBLIC_COMPLIANCE_CONFIG_ID ?? "0x86992112698f70634cd2e31aeb1afa4431392c074f575851587a3366c7282a78";
export const REQUIRED_KYC_LEVEL = 1;

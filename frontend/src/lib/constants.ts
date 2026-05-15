export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? "testnet") as "testnet" | "mainnet";
export const PACKAGE_ID = process.env.NEXT_PUBLIC_PACKAGE_ID ?? "0x012c67d9ab33090d6dcc4c3ee5e14411d6f18fa78d8b7bb44cda80a9135a1516";
export const POOL_ID = process.env.NEXT_PUBLIC_POOL_ID ?? "0xf495343b04169c6700a6a980d9828062a51ab7e138ec7936b354537058b7a582";
export const TREASURY_CAP_ID = process.env.NEXT_PUBLIC_TREASURY_CAP_ID ?? "0x496e1611290c714b3e627fbd10745c59bf921a02a6f1310e6cea9f05b96d44c4";
export const ADMIN_CAP_ID = process.env.NEXT_PUBLIC_ADMIN_CAP_ID ?? "0xc88d74427ab9cfea6c999fa43c05033ec49dbac482016ce97d3d0853cd65806b";
export const TOKEN_TYPE = `${PACKAGE_ID}::token::TOKEN`;
export const THRESHOLD = BigInt(process.env.NEXT_PUBLIC_THRESHOLD ?? "1000000000"); // 1000 VEIL (6 decimals)
export const EPOCH_DURATION_MS = Number(process.env.NEXT_PUBLIC_EPOCH_DURATION_MS ?? "3600000"); // 1h testnet

// Polling
export const REFETCH_INTERVAL_MS = 10_000;

// Display
export const VEIL_DECIMALS = 6;
export const EXPLORER_TX_URL = `https://suiscan.xyz/${NETWORK}/tx`;

// Compliance (Tier 3)
export const COMPLIANCE_CONFIG_ID = process.env.NEXT_PUBLIC_COMPLIANCE_CONFIG_ID ?? "0xc02ba70e1c22a499aef94f11b570f7303d96435d24741c2884588a508e3ee10a";
export const REQUIRED_KYC_LEVEL = 1;

export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? "testnet") as "testnet" | "mainnet";
export const PACKAGE_ID = process.env.NEXT_PUBLIC_PACKAGE_ID ?? "0x468e707669e33ef8664fd0f25fb16ee86623feab98254cc9c22044e79a371737";
export const POOL_ID = process.env.NEXT_PUBLIC_POOL_ID ?? "0x9b8e6bb7f09a483d8ec50c91f9e9f64a1d91bac64706afe56653c46a1ed720ba";
export const TREASURY_CAP_ID = process.env.NEXT_PUBLIC_TREASURY_CAP_ID ?? "0xf2b51f2995dc8fdebb0342cabc3d162b7159a91cda2ecb1d1b46988129e366d2";
export const ADMIN_CAP_ID = process.env.NEXT_PUBLIC_ADMIN_CAP_ID ?? "0xd35a6feee94564c8a65d709a8f0968819f3cc2527db4f8dc0f98a4f8fad8e5d3";
export const TOKEN_TYPE = `${PACKAGE_ID}::token::TOKEN`;
export const THRESHOLD = BigInt(process.env.NEXT_PUBLIC_THRESHOLD ?? "1000000000"); // 1000 VEIL (6 decimals)
export const EPOCH_DURATION_MS = Number(process.env.NEXT_PUBLIC_EPOCH_DURATION_MS ?? "3600000"); // 1h testnet

// Display
export const VEIL_DECIMALS = 6;
export const EXPLORER_TX_URL = `https://suiscan.xyz/${NETWORK}/tx`;

// Compliance (Tier 3)
export const COMPLIANCE_CONFIG_ID = process.env.NEXT_PUBLIC_COMPLIANCE_CONFIG_ID ?? "0x5999ace2cfcc952dc66dce83b3314930e435f99ee49abc11972871b5ecf5ed29";
export const REQUIRED_KYC_LEVEL = 1;

export const NETWORK = "testnet" as const;
export const PACKAGE_ID = "0x5a812d9ba12f2ba370f43a4b68365c2252730dede718eb7d25e8ed600fd513b1";
export const POOL_ID = ""; // Set after create_pool tx
export const TREASURY_CAP_ID = "0xb535125626416f98b8b805ae7319db3a5863561948f12d2bd8e890d1db22491a";
export const TOKEN_TYPE = `${PACKAGE_ID}::token::TOKEN`;
export const THRESHOLD = 1000_000000n; // 1000 VEIL (6 decimals)
export const EPOCH_DURATION_MS = 2_592_000_000; // 30 days

// Compliance (Tier 3)
export const COMPLIANCE_CONFIG_ID = ""; // Set after create_compliance_config tx
export const REQUIRED_KYC_LEVEL = 1;

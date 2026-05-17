/** @type {import('next').NextConfig} */
const nextConfig = {
  // ESM packages that reference browser globals need transpilation for SSR
  transpilePackages: [
    "@mysten/dapp-kit-react",
    "@mysten/dapp-kit-core",
    "@mysten/sui",
  ],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
              "connect-src 'self' https://fullnode.testnet.sui.io https://sui-testnet.mystenlabs.com wss://sui-testnet.mystenlabs.com https://sui-mainnet.mystenlabs.com http://localhost:3001",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data:",
            ].join("; "),
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // snarkjs relies on Node built-ins not available in browser bundles
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        readline: false,
        crypto: false,
        path: false,
        os: false,
      };
    }
    return config;
  },
};

export default nextConfig;

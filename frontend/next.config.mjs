/** @type {import('next').NextConfig} */
const nextConfig = {
  // ESM packages that reference browser globals need transpilation for SSR
  transpilePackages: [
    "@mysten/dapp-kit-react",
    "@mysten/dapp-kit-core",
    "@mysten/sui",
  ],
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

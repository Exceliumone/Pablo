import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@pablo/shared-types"],
  images: {
    // Server-side re-encoding needs `sharp`'s native binary, which isn't
    // guaranteed to build on every deploy target. Revisit once a hosting
    // target is picked (§ infra in docs/ARCHITECTURE.md) — until then,
    // next/image still gives lazy-loading and layout stability, it just
    // serves the source files as-is.
    unoptimized: true,
  },
};

export default nextConfig;

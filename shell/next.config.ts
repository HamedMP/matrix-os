import { resolve } from "node:path";
import type { NextConfig } from "next";

const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: {
    root: resolve(__dirname, ".."),
  },
  // Disable Turbopack filesystem cache in Docker -- stale cache causes
  // phantom build errors after host file changes via volume mount
  turbopackFileSystemCache: process.env.NODE_ENV === "development" && process.env.MATRIX_HOME
    ? false
    : undefined,
  async rewrites() {
    return [
      {
        source: "/icons/:path*",
        destination: `${gatewayUrl}/files/system/icons/:path*`,
      },
    ];
  },
};

export default nextConfig;

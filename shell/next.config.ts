import { resolve } from "node:path";
import type { NextConfig } from "next";

const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: {
    root: resolve(__dirname, ".."),
  },
  turbopackFileSystemCache:
    process.env.NODE_ENV === "development" && process.env.MATRIX_HOME
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

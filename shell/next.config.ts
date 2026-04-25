import { resolve } from "node:path";
import type { NextConfig } from "next";

const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Allow HMR websockets when the dev shell is reached through a tunnel
  // (staging.matrix-os.com) rather than localhost. Next 16 blocks dev
  // resources on cross-origin hostnames by default.
  allowedDevOrigins: [
    "staging.matrix-os.com",
    "localhost",
    "127.0.0.1",
  ],
  // Next's default trailing-slash 308 redirect breaks spec 063 app-runtime:
  // the iframe navigates to /apps/{slug}/ (trailing slash), Next 308s to
  // /apps/{slug} (no slash), and the browser drops the cookie because its
  // Path=/apps/{slug}/ no longer matches. Keep the slash so proxy.ts can
  // forward the URL verbatim to the gateway dispatcher.
  skipTrailingSlashRedirect: true,
  turbopack: {
    root: resolve(__dirname, ".."),
  },
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

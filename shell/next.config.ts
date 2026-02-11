import { resolve } from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: {
    root: resolve(__dirname, ".."),
  },
};

export default nextConfig;

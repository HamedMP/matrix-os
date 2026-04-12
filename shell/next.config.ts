import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:4000";

// In git worktrees, pnpm creates symlinks pointing to the main repo's
// node_modules. Turbopack can't resolve files outside its root, so we
// detect worktrees and widen the root to encompass both repos.
function findTurbopackRoot(): string {
  const projectRoot = resolve(__dirname, "..");
  try {
    const gitRef = readFileSync(resolve(projectRoot, ".git"), "utf8").trim();
    if (gitRef.startsWith("gitdir:")) {
      const mainRoot = resolve(gitRef.slice(8).trim(), "../../..");
      const p1 = projectRoot.split("/");
      const p2 = mainRoot.split("/");
      let i = 0;
      while (i < p1.length && i < p2.length && p1[i] === p2[i]) i++;
      return p1.slice(0, i).join("/") || "/";
    }
  } catch {}
  return projectRoot;
}

const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: {
    root: findTurbopackRoot(),
    resolveAlias: {
      "lodash-es": "lodash",
    },
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

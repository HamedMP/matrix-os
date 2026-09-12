import type { ServerResponse } from "node:http";
import { RUNNING_RUNTIME_COMPATIBILITY } from "@matrix-os/contracts";

export interface SystemInfoFixtureOptions {
  status?: 200 | 502;
  availableVersion?: string;
}

/** Serve provenance through HTTP so Electron's auth/CORS layer remains in use. */
export function createSystemInfoFixture(commit: string, options: SystemInfoFixtureOptions = {}) {
  let info: Record<string, unknown> = {
    version: "stub",
    build: { sha: commit },
    runtimeCompatibility: RUNNING_RUNTIME_COMPATIBILITY,
    uptime: 1,
    runtime: { handle: "neo", runtimeSlot: "primary" },
    resources: { cpuCount: 8, memoryTotal: 8e9, memoryFree: 4e9, diskTotal: 1e11, diskFree: 5e10 },
  };
  let cloudUpdatePosts = 0;
  const latest = options.availableVersion ? { version: options.availableVersion, channel: "dev", gitCommit: commit } : null;
  return {
    cloudUpdatePosts: () => cloudUpdatePosts,
    handleRequest(path: string, method: string, response: ServerResponse): boolean {
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (path === "/api/system/info") {
        send(options.status ?? 200, options.status === 502 ? { error: "Service unavailable" } : info);
      } else if (path === "/api/system/update" && method === "POST") {
        cloudUpdatePosts += 1;
        send(503, { error: "Cloud installation is unavailable in this fixture" });
      } else if (path === "/api/system/update" && latest) {
        send(200, { channel: "dev", latest, updateAvailable: true });
      } else if (path === "/api/system/releases" && latest) {
        send(200, { channel: "dev", releases: [latest] });
      } else {
        return false;
      }
      return true;
    },
    read: () => info,
    setBuildCommit: (sha: string) => { info = { ...info, build: { sha } }; },
    setSystemInfo: (value: Record<string, unknown>) => { info = structuredClone(value); },
  };
}

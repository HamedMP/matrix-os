import { RUNNING_RUNTIME_COMPATIBILITY } from "@matrix-os/contracts";

/** Serve provenance through HTTP so Electron's auth/CORS layer remains in use. */
export function createSystemInfoFixture(commit: string) {
  let info: Record<string, unknown> = {
    version: "stub",
    build: { sha: commit },
    runtimeCompatibility: RUNNING_RUNTIME_COMPATIBILITY,
    uptime: 1,
    runtime: { handle: "neo", runtimeSlot: "primary" },
    resources: { cpuCount: 8, memoryTotal: 8e9, memoryFree: 4e9, diskTotal: 1e11, diskFree: 5e10 },
  };
  return {
    read: () => info,
    setBuildCommit: (sha: string) => { info = { ...info, build: { sha } }; },
    setSystemInfo: (value: Record<string, unknown>) => { info = structuredClone(value); },
  };
}

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const launcherPath = "distro/customer-vps/host-bin/matrix-integrations-mcp";
const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

/** The installed launcher with its host paths pointed at a fixture node that prints what it received. */
async function launcher() {
  const dir = await mkdtemp(join(tmpdir(), "matrix-mcp-task-binding-"));
  fixtures.push(dir);
  const hostEnv = join(dir, "host.env");
  const nodeBin = join(dir, "fake-node");
  const serverPath = join(dir, "cli.js");
  await writeFile(hostEnv, "MATRIX_AUTH_TOKEN=fixture-host-token-long\nMATRIX_CLERK_USER_ID=fixture_owner\n");
  await writeFile(nodeBin, '#!/bin/sh\nprintf "project=%s task=%s host=%s\\n" "${MATRIX_PROJECT_ID-UNSET}" "${MATRIX_TASK_ID-UNSET}" "${MATRIX_AUTH_TOKEN-UNSET}"\n', { mode: 0o755 });
  await writeFile(serverPath, "// fixture only\n");
  const script = (await readFile(launcherPath, "utf8"))
    .replace('HOST_ENV_FILE="/opt/matrix/env/host.env"', `HOST_ENV_FILE="${hostEnv}"`)
    .replace('NODE_BIN="/opt/matrix/runtime/node/bin/node"', `NODE_BIN="${nodeBin}"`)
    .replace('SERVER_PATH="/opt/matrix/app/packages/integrations-mcp/dist/cli.js"', `SERVER_PATH="${serverPath}"`);
  return (env: Record<string, string>) => spawnSync("bash", ["-c", script, "matrix-integrations-mcp"], {
    encoding: "utf8", timeout: 5_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
}

// Fault detected: the launcher started Node with `env -i` and dropped MATRIX_PROJECT_ID and
// MATRIX_TASK_ID, so a task terminal's agent ran its board tools unbound, with owner
// credentials, able to reach every project's board.
describe("integrations MCP launcher task binding", () => {
  it("forwards a validated task binding on the owner-credential path", async () => {
    const run = await launcher();
    const bound = run({ MATRIX_PROJECT_ID: "proj_alpha", MATRIX_TASK_ID: "task_42" });
    expect(bound.status, bound.stderr).toBe(0);
    expect(bound.stdout).toContain("project=proj_alpha task=task_42 host=fixture-host-token-long");
    const projectOnly = run({ MATRIX_PROJECT_ID: "proj_alpha" });
    expect(projectOnly.stdout).toContain("project=proj_alpha task=UNSET");
    const unbound = run({});
    expect(unbound.status, unbound.stderr).toBe(0);
    expect(unbound.stdout).toContain("project=UNSET task=UNSET");
  });

  it("forwards the binding next to a scoped run capability", async () => {
    const run = await launcher();
    const scoped = run({ MATRIX_AGENT_INTEGRATIONS_TOKEN: "a".repeat(64), MATRIX_PROJECT_ID: "proj_alpha", MATRIX_TASK_ID: "task_42" });
    expect(scoped.status, scoped.stderr).toBe(0);
    expect(scoped.stdout).toContain("project=proj_alpha task=task_42 host=UNSET");
  });

  it.each([
    [{ MATRIX_PROJECT_ID: "../etc" }],
    [{ MATRIX_PROJECT_ID: "proj_alpha", MATRIX_TASK_ID: "task_42;rm" }],
    [{ MATRIX_TASK_ID: "task_42" }],
    [{ MATRIX_PROJECT_ID: "" , MATRIX_TASK_ID: "task_42" }],
  ])("refuses a malformed or partial binding instead of starting unbound (%j)", async (env) => {
    const run = await launcher();
    const refused = run(env);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain("task session binding is invalid");
    expect(refused.stdout).toBe("");
  });
});

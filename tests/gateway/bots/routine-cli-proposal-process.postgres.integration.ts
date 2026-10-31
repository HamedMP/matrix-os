import { sql } from "kysely";
import { createRealBotStateDatabase } from "./bot-state-support.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { mkdtemp, rm, symlink, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
let directory = "", artifact = "", expectedHash = "";
beforeAll(async () => {
  if (!process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL) return; // Each required case fails explicitly below; never skip qualification.
  directory = await mkdtemp(join(tmpdir(), "routine-cli-proposal-build-")); artifact = join(directory, "proposal.mjs");
  await symlink(await realpath("node_modules"), join(directory, "node_modules"), "dir");
  const result = await build({ entryPoints: ["tests/gateway/bots/routine-cli-proposal-process.ts"], outfile: artifact,
    bundle: true, packages: "external", platform: "node", format: "esm", target: "node24", metafile: true,
    banner: { js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);' },
    plugins: [{ name: "current-workspace-sources", setup(api) {
      api.onResolve({ filter: /^@(matrix-os|finnaai)\// }, async args => {
        const [, name, ...subpath] = args.path.split("/");
        const packageRoot = resolve("packages", name!);
        const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { exports: Record<string, string | { types?: string; import?: string }> };
        const entry = manifest.exports[subpath.length ? "./" + subpath.join("/") : "."];
        const relative = typeof entry === "string" ? entry : entry?.types ?? entry?.import;
        if (!relative) throw new Error("Missing current workspace source export");
        const file = await realpath(resolve(packageRoot, relative));
        if (!file.startsWith(resolve("packages") + "/")) throw new Error("Compiled fixture resolved outside owned workspace packages");
        return { path: file };
      });
    } }] });
  expect(Object.keys(result.metafile!.inputs).some(path => path.endsWith("routine-cli-proposals.ts"))).toBe(true);
  expect(Object.keys(result.metafile!.inputs).some(path => path.endsWith("task-orchestrator.ts"))).toBe(true);
  for (const file of Object.keys(result.metafile!.inputs).filter(file => file.startsWith("packages/"))) expect(await realpath(file)).toBe(resolve(file));
  expectedHash = createHash("sha256").update(await readFile(artifact)).digest("hex");
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
it.each(["pending-recovery", "lost-ack"])("compiled actual canonical proposal preserves %s without model call or approval replay", async mode => {
  if (!process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required for built canonical proposal process");
  expect(createHash("sha256").update(await readFile(artifact)).digest("hex")).toBe(expectedHash);
  const data = await createRealBotStateDatabase(process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL);
  const schema = (await sql<{ schema: string }>`SELECT current_schema() AS schema`.execute(data.db)).rows[0]!.schema;
  try {
  const { stdout } = await promisify(execFile)(process.execPath, [artifact, mode], { timeout: 20000, maxBuffer: 65536,
    env: { PATH: process.env.PATH, MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL: process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL,
      MATRIX_ROUTINE_SCHEMA: schema, MATRIX_NO_TELEMETRY: "1", OTEL_SDK_DISABLED: "true", POSTHOG_DISABLED: "true", TZ: "UTC" } });
  const proof = stdout.split("\n").find(line => line.startsWith('{"proof":"canonical-proposal"'));
  expect(proof).toBeTruthy();
  expect(JSON.parse(proof!)).toMatchObject({ modelCalls: 0, lost: mode === "lost-ack", tasks: [{ status: "waiting_person" }],
    approvals: [{ status: "pending" }], routines: [], current: { receipt: { disposition: "queued" }, proposal: { handoff: "pending_approval", approval: "pending" } } });
  } finally { await data.destroy(); }
});

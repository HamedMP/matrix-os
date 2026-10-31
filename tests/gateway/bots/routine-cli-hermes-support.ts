import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { claudeFixture } from "./routine-cli-claude-support.js";
import { createHermesChatProviderAdapter } from "../../../packages/gateway/src/chat/hermes-provider-adapter.js";
/** Actual admitted Hermes adapter/source/fixed CLI/private IPC/HTTP/PG. Public native API, pin, auth and model are separate fixtures. */
export async function hermesFixture(native: { intent: { args: string[]; stdin?: string }; hold?: boolean; duplicate?: boolean; missingCatalog?: boolean; loseEnableAck?: boolean; frame?: unknown }) {
  const f = await claudeFixture({ sourceDriver: "hermes" }), home = await mkdtemp("/tmp/rh-");
  const records = join(home, "records"), control = join(home, "control"), config = join(home, "fixture.json");
  await writeFile(records, ""); await writeFile(config, JSON.stringify({ ...native, records, control }));
  const children: ChildProcess[] = [];
  const adapter = createHermesChatProviderAdapter({ homePath: home, routineCli: { runtime: f.runtime, ...f.transport },
    spawnFn(_command, _args, options) {
      if (options.stdio.length !== 4) throw new Error("Missing actual private fourth FD");
      const child = spawn(process.execPath, [resolve("tests/fixtures/hermes-routine-process.mjs"), config], { stdio: options.stdio, env: { PATH: process.env.PATH, HOME: home, MATRIX_NO_TELEMETRY: "1" } });
      children.push(child); return child;
    } });
  f.setSourceAdapter(adapter);
  return { ...f, adapter, children, control,
    async frames() { return (await readFile(records, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line)); },
    async close() { await writeFile(control, "end"); await f.close(); for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await rm(home, { recursive: true, force: true }); },
  };
}

import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, chmod, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenClawSettingsConnection } from "../../packages/gateway/src/ai-providers/openclaw-settings-auth.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(version = "2026.7.1", exit = 0, delay = false) {
  const root = await mkdtemp(join(tmpdir(), "openclaw-settings-")); roots.push(root);
  const command = join(root, "openclaw");
  await writeFile(command, `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('${version}');
else if (process.argv.includes('--help')) console.log('paste-api-key --provider --profile-id');
else { let key=''; for await (const chunk of process.stdin) key+=chunk; if (process.argv.slice(2).join(' ') !== 'models auth paste-api-key --provider openai --profile-id openai:manual') process.exit(3); if (key !== 'fixture-key\\n') process.exit(4); console.error('private-native-output'); ${delay ? "(await import('node:fs')).writeFileSync('started','yes'); setTimeout(() => process.exit(0), 60000);" : `process.exit(${exit});`} }
`); await chmod(command, 0o700);
  const enableConnected = vi.fn(async () => {});
  const fetchFn = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
  return { root, connection: createOpenClawSettingsConnection({ command, cwd: root, env: { PATH: process.env.PATH }, enableConnected, fetchFn }), enableConnected, fetchFn };
}
it("gates direct API-key capability to the pinned supported CLI", async () => {
  expect(await (await fixture()).connection.capabilities()).toEqual({ login: false, apiKey: true });
  expect(await (await fixture("2026.9.1")).connection.capabilities()).toEqual({ login: false, apiKey: false });
});
it("validates remotely then sends key only to native stdin and enables exact harness", async () => {
  const f = await fixture(); await f.connection.verifyKey({ harnessInstanceId: "harness_openclaw", providerId: "openai", apiKey: "fixture-key" });
  expect(f.enableConnected).toHaveBeenCalledWith("harness_openclaw", expect.stringMatching(/^openclaw-key-/));
});
it("native persistence failure never enables or exposes native output", async () => {
  const f = await fixture("2026.7.1", 1);
  await expect(f.connection.verifyKey({ harnessInstanceId: "harness_openclaw", providerId: "openai", apiKey: "fixture-key" })).rejects.toMatchObject({ code: "unavailable" });
  expect(f.enableConnected).not.toHaveBeenCalled();
});
it("closed adapters reject new probes and credential writes", async () => {
  const f = await fixture(); await f.connection.close();
  expect(await f.connection.capabilities()).toEqual({ login: false, apiKey: false });
  await expect(f.connection.verifyKey({ harnessInstanceId: "harness_openclaw", providerId: "openai", apiKey: "fixture-key" })).rejects.toMatchObject({ code: "unavailable" });
  expect(f.fetchFn).not.toHaveBeenCalled(); expect(f.enableConnected).not.toHaveBeenCalled();
});
it("shutdown during verification prevents native writes and enablement", async () => {
  const f = await fixture();
  let finish!: (response: Response) => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  vi.mocked(f.fetchFn).mockImplementationOnce(async () => { started(); return new Promise<Response>(resolve => { finish = resolve; }); });
  const result = f.connection.verifyKey({ harnessInstanceId: "harness_openclaw", providerId: "openai", apiKey: "fixture-key" });
  const assertion = expect(result).rejects.toMatchObject({ code: "unavailable" });
  await startedPromise; await f.connection.close(); finish(new Response(null, { status: 200 })); await assertion;
  expect(f.enableConnected).not.toHaveBeenCalled();
});
it("shutdown reaps an active native save and prevents success enablement", async () => {
  const f = await fixture("2026.7.1", 0, true);
  const assertion = expect(f.connection.verifyKey({ harnessInstanceId: "harness_openclaw", providerId: "openai", apiKey: "fixture-key" })).rejects.toMatchObject({ code: "unavailable" });
  let started = false;
  for (let n = 0; n < 200; n++) {
    try { await access(join(f.root, "started")); started = true; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(started).toBe(true); await f.connection.close(); await assertion;
  expect(f.enableConnected).not.toHaveBeenCalled();
});

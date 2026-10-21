import { afterEach, expect, it, vi } from "vitest";
import { promisify } from "node:util";
import { spawnSync, type execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHermesChatProviderAdapter } from "../../packages/gateway/src/chat/hermes-provider-adapter.js";
import { createHermesNativeCredentialKindReader } from "../../packages/gateway/src/agent-config/hermes-native-credential-kind.js";
import { fakeGateway, baseInput } from "./hermes-test-gateway.js";

const SENTINELS = { ANTHROPIC_API_KEY: "gateway-anthropic-secret", OPENAI_API_KEY: "gateway-openai-secret", MATRIX_PLATFORM_API_KEY: "gateway-platform-secret", DATABASE_URL: "gateway-database-secret", PYTHONPATH: "/gateway/private/python" };
afterEach(() => vi.unstubAllEnvs());
async function run(browser: boolean, homePath = "/home/matrix/home") {
  for (const [key, value] of Object.entries(SENTINELS)) vi.stubEnv(key, value);
  const gateway = fakeGateway();
  const broker = { openRun: vi.fn(() => ({ token: "b".repeat(43), expiresAt: Date.now() + 60000 })), closeRun: vi.fn(async () => undefined) };
  const adapter = createHermesChatProviderAdapter({ homePath, spawnFn: gateway.spawnFn, ...(browser ? { sharedBrowser: broker as never, sharedBrowserGatewayPort: 4000 } : {}) });
  const output = (async () => { const events = []; for await (const event of adapter.start(baseInput)) events.push(event); return events; })();
  await vi.waitFor(() => expect(gateway.requests.some(r => r.method === "config.set" && r.params.key === "yolo")).toBe(true));
  if (browser) gateway.event("session.info", { provider: "openai-codex", model: "gpt-5.6-luna", tools: { mcp: ["mcp__matrix_shared_browser__shared_browser"] } });
  await vi.waitFor(() => expect(gateway.requests.some(r => r.method === "prompt.submit")).toBe(true));
  gateway.event("message.complete", { text: "Synthetic completed", status: "complete" });
  expect((await output).at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
  return gateway.spawnFn.mock.calls[0]![2].env;
}
it.each([false, true])("isolates ordinary/browser Hermes from Gateway secrets (browser=%s)", async browser => {
  const environment = await run(browser);
  for (const key of Object.keys(SENTINELS).filter(k => k !== "PYTHONPATH")) expect(environment).not.toHaveProperty(key);
  expect(environment.PYTHONPATH).toBe("/home/matrix/home/.hermes/hermes-agent");
  expect(environment).toMatchObject({ HOME: "/home/matrix/home", MATRIX_HOME: "/home/matrix/home", HERMES_HOME: "/home/matrix/home/.hermes", HERMES_PYTHON_SRC_ROOT: "/home/matrix/home/.hermes/hermes-agent", PYTHONUNBUFFERED: "1", HERMES_SINGLE_QUERY_SESSION: "1" });
  expect(environment.PATH.split(":").slice(0, 2)).toEqual(["/home/matrix/home/.local/bin", "/opt/matrix/runtime/node/bin"]);
  if (browser) expect(environment.MATRIX_SHARED_BROWSER_TOKEN).toBe("b".repeat(43));
  else expect(environment).not.toHaveProperty("MATRIX_SHARED_BROWSER_TOKEN");
});
it("qualifies the same native auth/profile environment used by actual execution", async () => {
  const environment = await run(false);
  const probe = vi.fn(async (..._args: unknown[]) => ({ stdout: JSON.stringify({ providerId: "anthropic", modelId: "native-model", credentialKind: "api_key" }) }));
  const execute = Object.assign(vi.fn(), { [promisify.custom]: probe }) as unknown as typeof execFile;
  const reader = createHermesNativeCredentialKindReader({ homePath: "/home/matrix/home", resolveRoot: async () => "/home/matrix/home/.hermes/hermes-agent", execute });
  expect(await reader(new AbortController().signal)).toMatchObject({ credentialKind: "api_key" });
  const qualified = (probe.mock.calls[0]![2] as { env: Record<string, string> }).env;
  for (const key of ["HOME", "MATRIX_HOME", "HERMES_HOME", "HERMES_PYTHON_SRC_ROOT", "PYTHONPATH", "PATH", "PYTHONUNBUFFERED"]) expect(qualified[key]).toBe(environment[key]);
  for (const key of Object.keys(SENTINELS).filter(k => k !== "PYTHONPATH")) expect(qualified).not.toHaveProperty(key);
});

it("keeps owner-native dotenv and auth files reachable without injecting their credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "matrix-hermes-env-"));
  try {
    await mkdir(join(home, ".hermes"));
    await writeFile(join(home, ".hermes/.env"), "ANTHROPIC_API_KEY=synthetic-native-only\n", { mode: 0o600 });
    await writeFile(join(home, ".hermes/auth.json"), JSON.stringify({ credential_pool: { anthropic: [{ source: "env:ANTHROPIC_API_KEY" }] } }), { mode: 0o600 });
    const environment = await run(false, home);
    const code = ["import os,json", "from pathlib import Path", "p=Path(os.environ.get('HERMES_HOME',str(Path(os.environ['HOME'])/'.hermes')))", "assert 'ANTHROPIC_API_KEY'not in os.environ", "dotenv=p.joinpath('.env').read_text()", "auth=json.loads(p.joinpath('auth.json').read_text())", "print(json.dumps({'nativeDotenvReachable':dotenv=='ANTHROPIC_API_KEY=synthetic-native-only\\n','nativeAuthReachable':auth['credential_pool']['anthropic']==[{'source':'env:ANTHROPIC_API_KEY'}]}))"].join("\n");
    const result = spawnSync("python3", ["-c", code], { env: environment, encoding: "utf8", timeout: 5_000, maxBuffer: 1024 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ nativeDotenvReachable: true, nativeAuthReachable: true });
  } finally { await rm(home, { recursive: true, force: true }); }
});

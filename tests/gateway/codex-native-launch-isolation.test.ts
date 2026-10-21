import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAgentLaunch } from "../../packages/gateway/src/agent-launcher.js";
import { agentLaunchTerminalCommand } from "../../packages/gateway/src/coding-agents/agent-launch-environment.js";
const execute = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const hostile = { OPENAI_API_KEY: "synthetic-key", CODEX_API_KEY: "synthetic-key", OPENAI_BASE_URL: "https://funded.invalid", CODEX_HOME: "/foreign", NODE_OPTIONS: "--trace-warnings", HTTPS_PROXY: "https://proxy.invalid", MATRIX_AI_TOKEN: "synthetic-token" };
const base = { agent: "codex" as const, cwd: "/tmp", runtimeHome: "/tmp/owner", prompt: "hello", sandbox: { enabled: true, mode: "workspace-write" as const } };
describe("native Codex final launch isolation", () => {
  it("pins native auth/config and prevents inherited environment in the verified runner", () => {
    for (const [key, value] of Object.entries(hostile)) vi.stubEnv(key, value);
    for (const providerEventPath of ["/tmp/owner/events.jsonl"]) {
      const launch = buildAgentLaunch({ ...base, providerEventPath, nativeCodexSubscription: { codexHome: "/tmp/owner/.codex", expectedPrincipalFingerprint: "a".repeat(64), expectedConsentRevision: 1, expectedConfigurationFingerprint: "b".repeat(64), expectedHarnessInstanceId: "codex_owner_openai_profile", expectedAccountId: "owner_codex" } });
      expect(launch.inheritEnv).toBe(false);
      expect(launch.env.HOME).toBe(base.runtimeHome);
      expect(launch.env.CODEX_HOME).toBe("/tmp/owner/.codex");
      for (const key of Object.keys(hostile).filter(key => key !== "CODEX_HOME")) expect(launch.env[key]).toBeUndefined();
      expect(launch.args).toContain('forced_login_method="chatgpt"');
      expect(launch.args).toContain('model_provider="openai"');
      expect(launch.args).toContain('openai_base_url=""');
      if (providerEventPath) expect(JSON.parse(Buffer.from(launch.args.at(-1)!, "base64").toString())).toMatchObject({ nativeSubscription: true });
    }
  });
  it("does not force native policy on generic key-mode Codex or other agents", () => {
    for (const agent of ["codex", "pi", "opencode"] as const) {
      const launch = buildAgentLaunch({ ...base, agent });
      expect(launch.inheritEnv).not.toBe(false);
      expect(launch.args).not.toContain('forced_login_method="chatgpt"');
    }
  });
  it("rejects native mode without owner home and incompatible provider model references", () => {
    expect(() => buildAgentLaunch({ ...base, nativeCodexSubscription: { codexHome: "/tmp/owner/.codex", expectedPrincipalFingerprint: "a".repeat(64), expectedConsentRevision: 1, expectedConfigurationFingerprint: "b".repeat(64), expectedHarnessInstanceId: "codex_owner_openai_profile", expectedAccountId: "owner_codex" } })).toThrow();
    expect(() => buildAgentLaunch({ ...base, providerEventPath: "/tmp/owner/events.jsonl", runtimeHome: undefined, nativeCodexSubscription: { codexHome: "/tmp/owner/.codex", expectedPrincipalFingerprint: "a".repeat(64), expectedConsentRevision: 1, expectedConfigurationFingerprint: "b".repeat(64), expectedHarnessInstanceId: "codex_owner_openai_profile", expectedAccountId: "owner_codex" } })).toThrow();
    expect(() => buildAgentLaunch({ ...base, providerEventPath: "/tmp/owner/events.jsonl", model: "openrouter/gpt-5", nativeCodexSubscription: { codexHome: "/tmp/owner/.codex", expectedPrincipalFingerprint: "a".repeat(64), expectedConsentRevision: 1, expectedConfigurationFingerprint: "b".repeat(64), expectedHarnessInstanceId: "codex_owner_openai_profile", expectedAccountId: "owner_codex" } })).toThrow();
  });
  it.each([false, true])("real background synthetic child honors inheritEnv=%s", async inheritEnv => {
    const dir = await mkdtemp(join(tmpdir(), "codex-env-")); dirs.push(dir);
    const output = join(dir, "child.json");
    const launch = { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify(process.env))`], cwd: dir, env: { HOME: dir, CODEX_HOME: join(dir, ".codex") }, inheritEnv };
    const launchPath = join(dir, "launch.json"); await writeFile(launchPath, JSON.stringify({ launch }));
    await execute(process.execPath, [join(process.cwd(), "packages/gateway/src/coding-agents/background-agent-runner.mjs"), launchPath], { env: { ...process.env, ...hostile }, timeout: 5_000 });
    const observed = JSON.parse(await readFile(output, "utf8"));
    for (const [key, value] of Object.entries(hostile).filter(([key]) => key !== "CODEX_HOME")) expect(observed[key]).toBe(inheritEnv ? value : undefined);
    expect(observed.CODEX_HOME).toBe(join(dir, ".codex"));
  });
  it.each([false, true])("real Terminal synthetic child honors inheritEnv=%s", async inheritEnv => {
    const launch = { command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify(process.env))"], cwd: "/tmp", env: { HOME: "/tmp/owner" }, inheritEnv };
    const [command, ...args] = agentLaunchTerminalCommand(launch);
    const result = await execute(command!, args, { env: { ...process.env, ...hostile }, timeout: 5_000 });
    const observed = JSON.parse(result.stdout);
    expect(observed.OPENAI_API_KEY).toBe(inheritEnv ? hostile.OPENAI_API_KEY : undefined);
    expect(observed.HOME).toBe("/tmp/owner");
  });
});

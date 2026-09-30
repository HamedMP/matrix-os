import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJevHermesCredentialResolver } from "../../packages/gateway/src/chat/jev-hermes-credentials.js";
import { normalizeHermesRuntimeSnapshot } from "../../packages/gateway/src/agent-config/hermes-source.js";
import { jevReadySettingsSnapshot } from "../fixtures/jev-inbox.js";
const time = Date.UTC(2026, 8, 29);
const token = (expires = time / 1000 + 3600) => ["e30", Buffer.from(JSON.stringify({ exp: expires,
  "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-owner" } })).toString("base64url"), "fixture"].join(".");
async function fixture(provider = "openai-codex", mode = "") {
  const home = await mkdtemp(join(tmpdir(), "jev-native-key-"));
  await mkdir(join(home, ".hermes")); await mkdir(join(home, "system"));
  const model = provider === "openrouter" ? "anthropic/claude-sonnet-5" : "gpt-5.6-sol";
  await writeFile(join(home, ".hermes/config.yaml"), JSON.stringify({ model: { provider,
    default: mode === "config-model" ? "different" : model, ...(mode === "endpoint" ? { base_url: "https://evil.example.test" } : {}) },
    shell_hooks: { command: "must-not-copy" }, fallback_providers: [{ provider: "anthropic", model: "other" }] }));
  await writeFile(join(home, ".hermes/.env"), "OPENAI_API_KEY=synthetic-openai-only\nOPENROUTER_API_KEY=synthetic-openrouter-only\nUNRELATED_SECRET=must-not-copy\n");
  await writeFile(join(home, ".hermes/auth.json"), JSON.stringify({ providers: { "openai-codex": {
    tokens: { access_token: token(mode === "expired" ? time / 1000 - 1 : undefined), refresh_token: "must-not-copy-refresh" } } },
    ...(mode === "pool" ? { credential_pool: { "openai-codex": [{ access_token: token(time / 1000 + 7200) }] } } : {}) }));
  if (mode === "symlink") { await rm(join(home, ".hermes/auth.json")); await symlink("/fixture/foreign-auth", join(home, ".hermes/auth.json")); }
  if (mode === "named-profile") await writeFile(join(home, ".hermes/active_profile"), "another-profile");
  if (mode === "active-symlink") await symlink("/fixture/profile", join(home, ".hermes/active_profile"));
  const snapshot = jevReadySettingsSnapshot(time);
  if (mode === "disabled") snapshot.harnesses[0]!.configuredEnabled = false;
  const runtime = normalizeHermesRuntimeSnapshot({ observedAt: mode === "stale" ? time - 6000 : time,
    status: { version: "0.21.4", gateway_running: true },
    options: { provider, model, providers: [{ slug: provider, name: provider,
      auth_type: provider === "openai-codex" ? "oauth" : "api_key",
      authenticated: mode !== "unauthenticated", models: [model] }] } });
  const runtimeSource = Object.assign(vi.fn(async () => runtime), { invalidate: vi.fn() });
  const resolve = createJevHermesCredentialResolver({ homePath: home, ownerId: "owner_fixture",
    settings: { getSnapshot: async () => snapshot }, runtimeSource, now: () => time });
  return { home, model, runtimeSource, resolve, close: () => rm(home, { recursive: true, force: true }) };
}
describe("Jev uses the configured native Hermes account without inheriting its profile", () => {
  it("uses the sole OAuth pool entry created by Hermes auth add without copying its refresh grant", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.home, ".hermes/auth.json"), JSON.stringify({ version: 1, providers: {},
        active_provider: "openai-codex", credential_pool: { "openai-codex": [{
          id: "fixture-device-login", source: "manual:device_code", auth_type: "oauth",
          access_token: token(), refresh_token: "must-not-copy-refresh", priority: 0,
        }] } }));
      const value = await f.resolve("owner_fixture", { instanceId: "hermes_default", model: `openai-codex:${f.model}` });
      expect(value.env).toEqual({ MATRIX_JEV_PRIMARY_KEY: token() });
      expect(JSON.stringify(value)).not.toContain("must-not-copy-refresh");
      expect(JSON.parse(await readFile(join(f.home, ".hermes/auth.json"), "utf8")).providers).toEqual({});
    } finally { await f.close(); }
  });
  it.each(["openai-codex", "openai-api", "openrouter"])("projects only %s's inference credential", async provider => {
    const f = await fixture(provider);
    try {
      const value = await f.resolve("owner_fixture", { instanceId: "hermes_default", model: `${provider}:${f.model}` });
      expect(value.provider).toBe(provider); expect(value.model).toBe(f.model);
      expect(value.apiMode).toBe(provider === "openrouter" ? "chat_completions" : "codex_responses");
      expect(value.env).toEqual({ MATRIX_JEV_PRIMARY_KEY: provider === "openai-codex" ? token()
        : provider === "openrouter" ? "synthetic-openrouter-only" : "synthetic-openai-only" });
      expect(JSON.stringify(value)).not.toContain("must-not-copy");
      expect(f.runtimeSource.invalidate).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
  it.each(["multiple", "expired", "custom-endpoint", "wrong-provider", "unsupported-source", "missing-refresh"])(
    "rejects a %s pool-only login instead of guessing a credential", async mode => {
      const f = await fixture();
      try {
        const entry = { access_token: token(mode === "expired" ? time / 1000 - 1 : undefined),
          refresh_token: mode === "missing-refresh" ? "" : "must-not-copy-refresh",
          auth_type: "oauth", source: mode === "unsupported-source" ? "foreign-profile" : "manual:device_code",
          ...(mode === "custom-endpoint" ? { base_url: "https://evil.example.test" } : {}) };
        await writeFile(join(f.home, ".hermes/auth.json"), JSON.stringify({ providers: {},
          active_provider: mode === "wrong-provider" ? "anthropic" : "openai-codex",
          credential_pool: { "openai-codex": mode === "multiple" ? [entry, entry] : [entry] } }));
        await expect(f.resolve("owner_fixture", { instanceId: "hermes_default", model: `openai-codex:${f.model}` })).rejects.toThrow();
      } finally { await f.close(); }
    });
  it.each(["expired", "pool", "config-model", "endpoint", "disabled", "stale", "unauthenticated", "symlink", "named-profile", "active-symlink"])(
    "rejects %s before any paid work rather than selecting another account", async mode => {
      const f = await fixture("openai-codex", mode);
      try { await expect(f.resolve("owner_fixture", { instanceId: "hermes_default", model: `openai-codex:${f.model}` })).rejects.toThrow(); }
      finally { await f.close(); }
    });
  it("rejects a credential replacement during native observation", async () => {
    const f = await fixture("openai-api");
    const initial = f.runtimeSource.getMockImplementation()!;
    f.runtimeSource.mockImplementationOnce(async () => {
      const result = await initial();
      await writeFile(join(f.home, ".hermes/.env"), "OPENAI_API_KEY=changed-key");
      return result;
    });
    try { await expect(f.resolve("owner_fixture", { instanceId: "hermes_default", model: `openai-api:${f.model}` })).rejects.toThrow(); }
    finally { await f.close(); }
  });
});

import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { buildAgentLaunch } from "../../packages/gateway/src/agent-launcher.js";
import { createCodexExecutionAdmission } from "../../packages/gateway/src/coding-agents/codex-execution-admission.js";
import { prepareOpenRouterCodexProfile } from "../../packages/gateway/src/coding-agents/openrouter-codex-profile.js";
import {
  assertOpenRouterCodexThreadProvider,
  createOpenRouterCodexExecutionProof,
} from "../../packages/gateway/src/coding-agents/openrouter-codex-execution-proof.mjs";

const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "codex-openrouter-"));
  homes.push(homePath);
  const credentialGeneration = randomUUID();
  const apiKey = "sk-or-v1-test-only";
  const model = "openai/gpt-5.6-luna";
  const directory = join(homePath, "system/ai-providers");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "openrouter-key.json"), JSON.stringify({
    version: 1,
    apiKey,
    credentialGeneration,
  }), { mode: 0o600 });
  await writeFile(join(directory, "settings.json"), JSON.stringify({
    schemaVersion: 1,
    revision: 4,
    harnesses: [{
      id: "codex_owner_openrouter",
      driverId: "codex",
      harness: "codex",
      displayName: "Codex",
      accentColor: null,
      enabled: true,
      selectedAccountId: "owner_openrouter",
      accessSourceId: "owner_openrouter",
      credentialGeneration,
      route: { kind: "fixed", providerId: "openrouter", modelId: model },
    }],
    accountProfiles: [],
    gatewayPolicy: null,
    receipts: [],
  }), { mode: 0o600 });
  const getSnapshot = async () => ({
    revision: 4,
    access: { mode: "writable" },
    accessSources: [{
      id: "owner_openrouter",
      providerId: "openrouter",
      accountId: "owner_openrouter",
      kind: "provider_account",
      fundingKind: "owner_api_key",
      credentialGeneration,
      eligibleModelIds: [model],
      readiness: {
        state: "ready",
        checkedAt: new Date().toISOString(),
        staleAfter: new Date(Date.now() + 60_000).toISOString(),
        action: "none",
        safeReason: null,
      },
    }],
    accounts: [{
      id: "owner_openrouter",
      providerId: "openrouter",
      accessSourceId: "owner_openrouter",
      authMethod: "api_key",
      authState: "authenticated",
    }],
  } as unknown as ProviderSettingsSnapshot);
  const admission = createCodexExecutionAdmission({
    homePath,
    isOwner: (userId) => userId === "owner",
    getSnapshot,
    readNativeAccount: async () => null,
  });
  return { admission, apiKey, credentialGeneration, directory, homePath, model };
}

describe("Codex OpenRouter execution", () => {
  it("binds the exact model and credential generation across start and launch admission", async () => {
    const f = await fixture();
    const binding = await f.admission.start("owner", "sess_openrouter");
    expect(binding).toMatch(/^[a-f0-9]{64}$/);
    await expect(f.admission.validateLaunch("owner", "sess_openrouter")).resolves.toMatchObject({
      kind: "openrouter",
      apiKey: f.apiKey,
      credentialGeneration: f.credentialGeneration,
      model: f.model,
      expectedHarnessInstanceId: "codex_owner_openrouter",
      expectedAccountId: "owner_openrouter",
    });

    const nextGeneration = randomUUID();
    await writeFile(join(f.directory, "openrouter-key.json"), JSON.stringify({
      version: 1,
      apiKey: "rotated-secret",
      credentialGeneration: nextGeneration,
    }), { mode: 0o600 });
    await expect(f.admission.validate("owner", binding, "sess_openrouter")).rejects.toThrow("unavailable");
  });

  it("writes a non-secret isolated profile and launches with only the admitted key", async () => {
    const f = await fixture();
    const codexHome = await prepareOpenRouterCodexProfile({
      homePath: f.homePath,
      credentialGeneration: f.credentialGeneration,
      model: f.model,
    });
    const config = await readFile(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('model_provider = "openrouter"');
    expect(config).toContain('base_url = "https://openrouter.ai/api/v1"');
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain(`model = "${f.model}"`);
    expect(config).not.toContain(f.apiKey);

    for (const [name, value] of Object.entries({
      OPENAI_API_KEY: "ambient-openai",
      CODEX_API_KEY: "ambient-codex",
      ANTHROPIC_API_KEY: "ambient-anthropic",
      OPENROUTER_API_KEY: "ambient-openrouter",
      CODEX_HOME: "/foreign",
    })) vi.stubEnv(name, value);
    const launch = buildAgentLaunch({
      agent: "codex",
      cwd: f.homePath,
      runtimeHome: f.homePath,
      providerEventPath: join(f.homePath, "events.jsonl"),
      prompt: "hello",
      sandbox: { enabled: true, mode: "workspace-write" },
      openRouterCodex: {
        kind: "openrouter",
        codexHome,
        apiKey: f.apiKey,
        credentialGeneration: f.credentialGeneration,
        model: f.model,
        expectedHarnessInstanceId: "codex_owner_openrouter",
        expectedAccountId: "owner_openrouter",
      },
    });
    expect(launch.inheritEnv).toBe(false);
    expect(launch.env).toMatchObject({
      HOME: f.homePath,
      CODEX_HOME: codexHome,
      OPENROUTER_API_KEY: f.apiKey,
    });
    expect(launch.env.OPENAI_API_KEY).toBeUndefined();
    expect(launch.env.CODEX_API_KEY).toBeUndefined();
    expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(launch.args.join(" ")).not.toContain(f.apiKey);
    const runnerConfig = JSON.parse(Buffer.from(launch.args.at(-1)!, "base64").toString("utf8"));
    expect(runnerConfig).toMatchObject({
      openRouter: true,
      expectedCredentialGeneration: f.credentialGeneration,
      model: f.model,
    });
    expect(JSON.stringify(runnerConfig)).not.toContain(f.apiKey);
  });

  it("rechecks saved consent and effective provider at start and before every turn", async () => {
    const f = await fixture();
    const codexHome = await prepareOpenRouterCodexProfile({
      homePath: f.homePath,
      credentialGeneration: f.credentialGeneration,
      model: f.model,
    });
    const request = vi.fn(async () => ({
      config: { model_provider: "openrouter", model: f.model },
    }));
    const verify = await createOpenRouterCodexExecutionProof(
      f.credentialGeneration,
      f.model,
      {
        harnessInstanceId: "codex_owner_openrouter",
        accountId: "owner_openrouter",
        configurationFingerprint: createHash("sha256").update(JSON.stringify({
          credentialGeneration: f.credentialGeneration,
          model: f.model,
        })).digest("hex"),
      },
      {
        HOME: f.homePath,
        CODEX_HOME: codexHome,
        OPENROUTER_API_KEY: f.apiKey,
      },
    );
    await expect(verify(request)).resolves.toBeUndefined();
    expect(() => assertOpenRouterCodexThreadProvider({ modelProvider: "openrouter" })).not.toThrow();
    expect(() => assertOpenRouterCodexThreadProvider({ modelProvider: "openai" })).toThrow("unavailable");

    await writeFile(join(f.directory, "openrouter-key.json"), JSON.stringify({
      version: 1,
      apiKey: "rotated-secret",
      credentialGeneration: randomUUID(),
    }), { mode: 0o600 });
    await expect(verify(request)).rejects.toThrow("unavailable");
  });
});

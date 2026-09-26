import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createCodexHarnessAdmission } from "../../packages/gateway/src/coding-agents/codex-harness-admission.js";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import { createCodingAgentRuntimeSummaryService } from "../../packages/gateway/src/coding-agents/runtime-summary.js";
import { createCodingAgentThreadStore, createFakeCodingAgentProvider } from "../../packages/gateway/src/coding-agents/thread-store.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const principal: RequestPrincipal = { userId: "owner_user", source: "jwt" };
const create = { providerId: "codex", prompt: "Inspect this project", clientRequestId: "req_codex_initial" };
const turn = { message: "Continue", clientRequestId: "req_codex_turn" };

async function saveCodexSetting(homePath: string, enabled: boolean): Promise<void> {
  const path = join(homePath, "system/ai-providers/settings.json");
  await mkdir(join(homePath, "system/ai-providers"), { recursive: true });
  await writeFile(path, JSON.stringify({
    schemaVersion: 1, revision: 1,
    harnesses: [{
      id: "harness_codex", driverId: "codex", harness: "codex", displayName: "Codex",
      accentColor: null, enabled, selectedAccountId: "account_openai",
      accessSourceId: "owner_openai_profile",
      route: { kind: "fixed", providerId: "openai", modelId: "openai/gpt-5.6" },
    }],
    accountProfiles: [], gatewayPolicy: null, receipts: [],
  }));
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("saved Codex harness authority at Workspace and Project admission", () => {
  it("preserves a working attempt until explicitly off, then rejects new runs while reads and idempotent retries survive", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "codex-saved-admission-"));
    const admission = createCodexHarnessAdmission({ homePath });
    const provider = createFakeCodingAgentProvider({ providerId: "codex" });
    const threads = createCodingAgentThreadStore({
      homePath, providers: [provider], providerAdmission: admission,
      relationValidator: { validateCreate: async () => undefined, validateThread: async () => undefined },
    });
    const summary = createCodingAgentRuntimeSummaryService({
      homePath, providerAdmission: admission,
      providerRegistry: { listProviders: async () => [{
        ...provider.getSummary!({ now: () => new Date() }), authStatus: "unknown" as const,
      }] },
    });
    const app = new Hono();
    app.route("/api/coding-agents", createCodingAgentRoutes({
      service: summary, threads, turns: threads, getPrincipal: () => principal,
    }));
    try {
      // A missing settings document retains legacy user-initiated attempts.
      expect((await summary.getSummary(principal)).providers[0]).toMatchObject({
        availability: "available", authStatus: "unknown",
      });
      const first = await app.request(post("/api/coding-agents/threads", create));
      expect(first.status).toBe(202);
      const threadId = (await first.json() as { thread: { id: string } }).thread.id;

      await saveCodexSetting(homePath, false);
      expect((await summary.getSummary(principal)).providers[0]).toMatchObject({
        id: "codex", availability: "unavailable", installStatus: "installed",
      });
      expect((await app.request(post("/api/coding-agents/threads", { ...create, clientRequestId: "req_codex_new" }))).status).toBe(400);
      expect((await app.request(post("/api/coding-agents/threads", create))).status).toBe(200);
      expect((await app.request(`http://localhost/api/coding-agents/threads/${threadId}`)).status).toBe(200);
      expect((await app.request(post(`/api/coding-agents/threads/${threadId}/turns`, turn))).status).toBe(409);

      await saveCodexSetting(homePath, true);
      expect((await summary.getSummary(principal)).providers[0]?.availability).toBe("available");
      expect((await app.request(post(`/api/coding-agents/threads/${threadId}/turns`, turn))).status).toBe(202);
      await saveCodexSetting(homePath, false);
      expect((await app.request(post(`/api/coding-agents/threads/${threadId}/turns`, turn))).status).toBe(200);
    } finally {
      await threads.shutdownTurns();
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed saved settings without changing other harnesses", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "codex-bad-settings-"));
    try {
      const admission = createCodexHarnessAdmission({ homePath });
      await mkdir(join(homePath, "system/ai-providers"), { recursive: true });
      await writeFile(join(homePath, "system/ai-providers/settings.json"), "{bad json");
      await expect(admission.isProviderEnabled("codex")).resolves.toBe(false);
      await expect(admission.isProviderEnabled("claude")).resolves.toBe(true);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });
});

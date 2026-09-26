import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createCodexHarnessAdmission } from "../../packages/gateway/src/coding-agents/codex-harness-admission.js";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import { createCodingAgentRuntimeSummaryService } from "../../packages/gateway/src/coding-agents/runtime-summary.js";
import { createCodingAgentThreadStore, createFakeCodingAgentProvider } from "../../packages/gateway/src/coding-agents/thread-store.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const principal: RequestPrincipal = { userId: "owner_user", source: "jwt" };
const supported = ["claude", "codex", "pi", "opencode"] as const;
type SupportedHarness = typeof supported[number];

function settingsPath(homePath: string): string {
  return join(homePath, "system/ai-providers/settings.json");
}

async function saveSettings(
  homePath: string,
  harnesses: readonly { harness: SupportedHarness; enabled: boolean }[],
): Promise<void> {
  await mkdir(join(homePath, "system/ai-providers"), { recursive: true });
  await writeFile(settingsPath(homePath), JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    harnesses: harnesses.map(({ harness, enabled }, index) => ({
      id: `harness_${harness}_${index}`,
      driverId: harness === "claude" ? "claude_code" : harness,
      harness,
      displayName: harness,
      accentColor: null,
      enabled,
      selectedAccountId: null,
      accessSourceId: null,
      route: { kind: "fixed", providerId: "openai", modelId: "openai/gpt-5.6" },
    })),
    accountProfiles: [], gatewayPolicy: null, receipts: [],
  }));
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("saved harness authority at direct Workspace and Project dispatch", () => {
  it.each(["claude", "pi", "opencode"] as const)(
    "denies fresh %s runs when saved off while preserving retries, reads, and active abort",
    async (providerId) => {
      const homePath = await mkdtemp(join(tmpdir(), "generic-saved-admission-"));
      const admission = createCodexHarnessAdmission({ homePath });
      const provider = createFakeCodingAgentProvider({ providerId });
      const startThread = vi.spyOn(provider, "startThread");
      const resumeTurn = vi.spyOn(provider, "resumeTurn");
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
      const initial = { providerId, prompt: "Inspect", clientRequestId: `req_${providerId}_initial` };
      const path = "/api/coding-agents/threads";
      try {
        // Missing settings retain legacy dispatch, including a resumable active thread.
        expect((await summary.getSummary(principal)).providers[0]?.availability).toBe("available");
        const created = await app.request(post(path, initial));
        expect(created.status).toBe(202);
        const threadId = (await created.json() as { thread: { id: string } }).thread.id;
        expect(startThread).toHaveBeenCalledTimes(1);

        await saveSettings(homePath, [{ harness: providerId, enabled: false }]);
        expect((await app.request(post(path, { ...initial, clientRequestId: `req_${providerId}_fresh` }))).status).toBe(400);
        expect((await app.request(post(path, {
          ...initial, projectId: "matrix-os", clientRequestId: `req_${providerId}_project`,
        }))).status).toBe(400);
        expect((await summary.getSummary(principal)).providers[0]).toMatchObject({
          id: providerId, availability: "unavailable", installStatus: "installed",
        });
        expect(startThread).toHaveBeenCalledTimes(1);
        expect((await app.request(post(path, initial))).status).toBe(200);
        expect((await app.request(`http://localhost${path}/${threadId}`)).status).toBe(200);
        const abortPath = `${path}/${threadId}/abort`;
        const aborted = await app.request(post(abortPath, { clientRequestId: `req_${providerId}_abort` }));
        expect(aborted.status).toBe(200);
        expect((await aborted.json() as { thread: { status: string } }).thread.status).toBe("aborted");
        expect((await app.request(post(abortPath, { clientRequestId: `req_${providerId}_abort` }))).status).toBe(200);

        const turnPath = `${path}/${threadId}/turns`;
        const turn = { message: "Continue", clientRequestId: `req_${providerId}_turn` };
        expect((await app.request(post(turnPath, turn))).status).toBe(409);
        expect(resumeTurn).not.toHaveBeenCalled();

        await saveSettings(homePath, [{ harness: providerId, enabled: true }]);
        expect((await summary.getSummary(principal)).providers[0]?.availability).toBe("available");
        expect((await app.request(post(turnPath, turn))).status).toBe(202);
        const projectCreate = { ...initial, projectId: "matrix-os", clientRequestId: `req_${providerId}_project_on` };
        const projectCreated = await app.request(post(path, projectCreate));
        expect(projectCreated.status).toBe(202);
        const projectThreadId = (await projectCreated.json() as { thread: { id: string } }).thread.id;
        await saveSettings(homePath, [{ harness: providerId, enabled: false }]);
        expect((await app.request(post(turnPath, turn))).status).toBe(200);
        expect((await app.request(post(path, projectCreate))).status).toBe(200);
        expect((await app.request(`http://localhost${path}/${projectThreadId}`)).status).toBe(200);
        expect((await app.request(post(`${path}/${projectThreadId}/turns`, {
          message: "Continue project", clientRequestId: `req_${providerId}_project_turn`,
        }))).status).toBe(409);
      } finally {
        await threads.shutdownTurns();
        await rm(homePath, { recursive: true, force: true });
      }
    },
  );

  it("allows a supported provider with no matching saved row and leaves unregistered IDs unavailable", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "generic-saved-no-row-"));
    const admission = createCodexHarnessAdmission({ homePath });
    const provider = createFakeCodingAgentProvider({ providerId: "pi" });
    const threads = createCodingAgentThreadStore({
      homePath, providers: [provider], providerAdmission: admission,
      relationValidator: { validateCreate: async () => undefined, validateThread: async () => undefined },
    });
    const app = new Hono();
    app.route("/api/coding-agents", createCodingAgentRoutes({
      threads, turns: threads, getPrincipal: () => principal,
    }));
    try {
      await saveSettings(homePath, [{ harness: "codex", enabled: false }]);
      await expect(admission.isProviderEnabled("pi")).resolves.toBe(true);
      expect((await app.request(post("/api/coding-agents/threads", {
        providerId: "pi", prompt: "Inspect", clientRequestId: "req_pi_no_row",
      }))).status).toBe(202);
      for (const providerId of ["openclaw", "hermes"]) {
        expect((await app.request(post("/api/coding-agents/threads", {
          providerId, prompt: "Inspect", clientRequestId: `req_${providerId}_unsupported`,
        }))).status).toBe(400);
      }
    } finally {
      await threads.shutdownTurns();
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("denies only when every matching saved harness row is off", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "generic-saved-multiple-"));
    try {
      const admission = createCodexHarnessAdmission({ homePath });
      await saveSettings(homePath, [
        { harness: "pi", enabled: false }, { harness: "pi", enabled: false },
      ]);
      await expect(admission.isProviderEnabled("pi")).resolves.toBe(false);
      await saveSettings(homePath, [
        { harness: "pi", enabled: false }, { harness: "pi", enabled: true },
      ]);
      await expect(admission.isProviderEnabled("pi")).resolves.toBe(true);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed, oversized, and symlinked saved policy for each supported harness", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "generic-saved-malformed-"));
    const admission = createCodexHarnessAdmission({ homePath });
    try {
      await mkdir(join(homePath, "system/ai-providers"), { recursive: true });
      await writeFile(settingsPath(homePath), "{bad json");
      for (const providerId of supported) {
        await expect(admission.isProviderEnabled(providerId)).resolves.toBe(false);
      }
      await writeFile(settingsPath(homePath), "x".repeat(1024 * 1024 + 1));
      for (const providerId of supported) {
        await expect(admission.isProviderEnabled(providerId)).resolves.toBe(false);
      }
      await rm(settingsPath(homePath));
      const target = join(homePath, "target.json");
      await writeFile(target, "{}");
      await symlink(target, settingsPath(homePath));
      for (const providerId of supported) {
        await expect(admission.isProviderEnabled(providerId)).resolves.toBe(false);
      }
      await expect(admission.isProviderEnabled("openclaw")).resolves.toBe(true);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("keeps missing-binary setup status ahead of saved-off availability in runtime summary", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "generic-saved-missing-binary-"));
    try {
      await saveSettings(homePath, [{ harness: "codex", enabled: false }, { harness: "pi", enabled: false }]);
      const admission = createCodexHarnessAdmission({ homePath });
      const provider = createFakeCodingAgentProvider({ providerId: "codex" });
      const summary = createCodingAgentRuntimeSummaryService({
        homePath, providerAdmission: admission,
        providerRegistry: { listProviders: async () => [{
          ...provider.getSummary!({ now: () => new Date() }),
          availability: "setup_required" as const, installStatus: "missing" as const,
        }, {
          ...createFakeCodingAgentProvider({ providerId: "pi" }).getSummary!({ now: () => new Date() }),
          availability: "setup_required" as const, installStatus: "missing" as const,
        }] },
      });
      expect((await summary.getSummary(principal)).providers).toEqual([
        expect.objectContaining({ id: "codex", availability: "setup_required", installStatus: "missing" }),
        expect.objectContaining({ id: "pi", availability: "setup_required", installStatus: "missing" }),
      ]);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });
});

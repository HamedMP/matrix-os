import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayCodingAgentProviderUsageService,
} from "../../packages/gateway/src/coding-agents/provider-usage-wiring.js";
import { createWorkspaceCodingAgentProviderSet } from "../../packages/gateway/src/coding-agents/workspace-provider.js";
import { testPrincipal } from "../helpers/activation-readiness.js";

const now = new Date("2026-08-10T12:00:00.000Z");

describe("gateway provider usage wiring", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let kysely: Kysely<any>;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    kysely = new Kysely({ dialect: pglite.dialect });
  });

  afterEach(async () => {
    await kysely.destroy();
  });

  it("bootstraps snapshots and returns provider usage over the shared database", async () => {
    const providerSet = createWorkspaceCodingAgentProviderSet({
      agents: ["codex"],
      runtime: { startSession: vi.fn(), stopSession: vi.fn() },
      codexUsageProbe: vi.fn(async () => [{
        id: "openai-chatgpt",
        displayName: "OpenAI / ChatGPT",
        linkedAgentProviderIds: ["codex"],
        state: "available",
        accuracy: "provider_reported",
        windows: [{ id: "primary", label: "5-hour window", remainingPercent: 72 }],
        observedAt: now.toISOString(),
        setupActions: [],
      }]),
    });
    const service = await createGatewayCodingAgentProviderUsageService({
      kysely,
      providers: providerSet.registryProviders,
      providerRegistry: {
        listProviders: async () => [{
          id: "codex",
          displayName: "Codex",
          kind: "codex",
          availability: "available",
          installStatus: "installed",
          authStatus: "authenticated",
          supportedModes: ["default"],
          defaultMode: "default",
          setupActions: [],
        }],
      },
      runtimeId: "rt_primary",
      now: () => now,
    });

    const response = await service?.getUsage(testPrincipal);

    expect(response?.usageSources).toEqual([
      expect.objectContaining({ id: "openai-chatgpt", state: "available" }),
    ]);
    const persisted = await sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM coding_agent_provider_quota_snapshots
    `.execute(kysely);
    expect(persisted.rows[0]?.count).toBe("1");

    service?.close();
    await expect(sql`SELECT 1`.execute(kysely)).resolves.toBeDefined();
  });

  it("does not create a fake usage service without Postgres", async () => {
    const listProviders = vi.fn();

    const service = await createGatewayCodingAgentProviderUsageService({
      kysely: null,
      providers: [],
      providerRegistry: { listProviders },
      runtimeId: "rt_primary",
      now: () => now,
    });

    expect(service).toBeUndefined();
    expect(listProviders).not.toHaveBeenCalled();
  });
});

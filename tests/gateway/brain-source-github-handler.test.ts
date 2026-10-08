import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrainFeatureError, type BrainIntegrationCallOutcome, type BrainIntegrationCaller, type BrainResolvedProject,
} from "../../packages/gateway/src/brain/contracts.js";
import {
  bootstrapBrainGithubDatabase, createBrainGithubSourceHandler, createGithubIntegrationClient, githubDocumentId,
} from "../../packages/gateway/src/brain/sources/github/index.js";
import { githubRepoOfPermalink } from "../../packages/gateway/src/brain/sources/github/config.js";
import { githubConditionalRows } from "../../packages/gateway/src/brain/sources/github/database.js";
import { brainContent, createBrainHarness, scopeA, type BrainHarness } from "./helpers/brain-store-helpers.js";
import { fakeFetch, githubConfig, githubFixture, jsonResponse, runGithubPages } from "./helpers/brain-source-github-fakes.js";

const TOKEN = "ghp_testtoken000000000000000000000000";
const project: BrainResolvedProject = { projectId: "proj_1", slug: "widgets", name: "Widgets", scope: scopeA };
let harness: BrainHarness;

function caller(outcome: BrainIntegrationCallOutcome | ((request: unknown) => BrainIntegrationCallOutcome)) {
  const calls: unknown[] = [];
  const integrations: BrainIntegrationCaller = {
    call: vi.fn(async (_owner, request) => {
      calls.push(request);
      return typeof outcome === "function" ? outcome(request) : outcome;
    }),
  };
  return { integrations, calls };
}

const REF = "https://github.com/acme/widgets";
type HandlerExtra = { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; integrations?: BrainIntegrationCaller; tokenOwnerIds?: string[] };
const handlerWith = (extra: HandlerExtra = {}) => createBrainGithubSourceHandler({
  kysely: harness.db, integrations: extra.integrations ?? caller({ status: "unavailable" }).integrations, env: extra.env ?? {},
  tokenOwnerIds: extra.tokenOwnerIds ?? ["owner_a"], ...(extra.fetch ? { fetch: extra.fetch } : {}),
});

async function newSource(externalRef = "https://github.com/acme/widgets", kind = "github"): Promise<string> {
  return (await harness.repository.createSource(scopeA, { kind, externalRef, label: "x" })).source.sourceId;
}

beforeEach(async () => {
  harness = await createBrainHarness();
  await bootstrapBrainGithubDatabase(harness.db);
  await bootstrapBrainGithubDatabase(harness.db);
});
afterEach(async () => harness.destroy());

describe("github source config", () => {
  it("parses a valid config and refuses everything outside the schema", () => {
    const handler = handlerWith();
    expect(handler.parseConfig({ ...githubConfig, accountLabel: "work" })).toEqual({ ...githubConfig, accountLabel: "work" });
    for (const bad of [
      { ...githubConfig, repo: "acme" }, { ...githubConfig, repo: "acme/.." }, { ...githubConfig, extra: 1 },
      { ...githubConfig, include: { pullRequests: false, reviews: true, issues: true } },
      { ...githubConfig, include: { pullRequests: false, reviews: false, issues: false } },
      { ...githubConfig, mode: "token", accountLabel: "work" }, { ...githubConfig, since: "2026-02-30" },
      { ...githubConfig, since: "2001-01-01" }, { ...githubConfig, accountLabel: " padded" }, null,
      { ...githubConfig, accountLabel: "a\u0000b" }, { ...githubConfig, accountLabel: "a\u0001b" },
      { ...githubConfig, accountLabel: "a\u0085b" },
    ]) {
      expect(() => handler.parseConfig(bad)).toThrow(BrainFeatureError);
    }
  });

  it("identifies the repository case-insensitively and shows a token-free view", () => {
    const handler = handlerWith();
    const config = { ...githubConfig, repo: "Acme/Widgets" };
    expect(handler.identify(project, config)).toEqual({ externalRef: "https://github.com/acme/widgets", label: "GitHub Acme/Widgets" });
    expect(handler.viewConfig(config)).toEqual({
      repo: "Acme/Widgets", mode: "integration", accountLabel: null, pullRequests: true, reviews: true, issues: true, since: "2026-01-01",
    });
  });

  it("stores, updates and loads config rows, which go with their source", async () => {
    const handler = handlerWith();
    const sourceId = await newSource();
    expect(await handler.loadConfig(scopeA, sourceId)).toBeNull();
    await handler.saveConfig(scopeA, sourceId, { ...githubConfig, accountLabel: "work" });
    expect(await handler.loadConfig(scopeA, sourceId)).toEqual({ ...githubConfig, accountLabel: "work" });
    const tokenConfig = { repo: "acme/widgets", mode: "token" as const, include: { pullRequests: false, reviews: false, issues: true } };
    await handler.saveConfig(scopeA, sourceId, tokenConfig);
    expect(await handler.loadConfig(scopeA, sourceId)).toEqual(tokenConfig);
    await harness.repository.eraseScope(scopeA);
    expect(await handler.loadConfig(scopeA, sourceId)).toBeNull();
  });

  it("mirrors the config schema in CHECKs, adds them to an older table and re-checks loaded rows", async () => {
    const handler = handlerWith();
    const sourceId = await newSource();
    const insert = (values: Record<string, unknown>) => harness.db.insertInto("brain_github_sources" as never).values({
      owner_id: scopeA.ownerId, scope_id: scopeA.scopeId, source_id: sourceId, repo: "acme/widgets", mode: "integration",
      account_label: null, include_pull_requests: true, include_reviews: false, include_issues: true, since: null,
      updated_at: new Date(), ...values,
    } as never).execute();
    for (const bad of [
      { account_label: "a\u0001b" }, { account_label: " padded " }, { account_label: "padded " }, { repo: "acme/.." },
      { repo: "./widgets" }, { since: "2026-02-30" }, { since: "2026-13-01" }, { since: "1999-01-01" }, { since: "2026-1-01" },
    ]) {
      await expect(insert(bad)).rejects.toThrow();
    }
    await insert({ account_label: "a b", since: "2024-02-29" });
    expect(await handler.loadConfig(scopeA, sourceId)).toMatchObject({ accountLabel: "a b", since: "2024-02-29" });
    // A table made before the named CHECK gains it at the next bootstrap; a row it never saw fails when loaded.
    await harness.db.deleteFrom("brain_github_sources" as never).execute();
    await sql`ALTER TABLE brain_github_sources DROP CONSTRAINT brain_github_sources_values_check`.execute(harness.db);
    await insert({ repo: "acme/.." });
    await bootstrapBrainGithubDatabase(harness.db);
    await expect(handler.loadConfig(scopeA, sourceId)).rejects.toMatchObject({ code: "source_config_invalid" });
    await harness.db.deleteFrom("brain_github_sources" as never).execute();
    await expect(insert({ repo: "acme/.." })).rejects.toThrow();
    // The CHECKs know only ASCII spaces; the loader refuses a label ending in a no-break space all the same.
    await insert({ account_label: "work\u00a0" });
    await expect(handler.loadConfig(scopeA, sourceId)).rejects.toMatchObject({ code: "source_config_invalid" });
  });

  it("refuses a repository other than the git source's github.com repository", async () => {
    const handler = handlerWith();
    const sourceId = await newSource();
    await newSource("https://github.com/ACME/widgets", "git");
    await expect(handler.checkConfig!(scopeA, githubConfig)).resolves.toBeUndefined();
    await expect(handler.checkConfig!(scopeA, { ...githubConfig, repo: "acme/other" }))
      .rejects.toMatchObject({ code: "source_conflict" });
    await expect(handler.saveConfig(scopeA, sourceId, githubConfig)).resolves.toBeUndefined();
    await expect(handler.saveConfig(scopeA, sourceId, { ...githubConfig, repo: "acme/other" }))
      .rejects.toMatchObject({ code: "source_conflict" });
    expect(await handler.createAdapter("owner_a", project, { ...githubConfig, repo: "acme/other" }))
      .toEqual({ ok: false, code: "config_invalid" });
  });

  it("takes the repository of a project git source from its synced pull request or commit permalinks", async () => {
    const handler = handlerWith();
    const sourceId = await newSource();
    const gitId = await newSource("project:proj_1", "git");
    await expect(handler.saveConfig(scopeA, sourceId, { ...githubConfig, repo: "acme/other" })).resolves.toBeUndefined();
    const doc = (seed: string, provenance: string, permalink: string, sourceUpdatedAt = "2026-09-01T00:00:00.000Z") =>
      ({ ...brainContent(seed, { provenance, permalink, sourceUpdatedAt }), refs: [] });
    await harness.repository.applySyncBatch(scopeA, { sourceId: gitId, expectedCursor: null, nextCursor: "c1", deletions: [], upserts: [
      doc("spec", "git_spec", "https://github.com/acme/other/blob/main/specs/1.md"),
      doc("commit", "git_commit", "https://github.com/Acme/Widgets/commit/abc"),
    ] });
    await expect(handler.saveConfig(scopeA, sourceId, { ...githubConfig, repo: "acme/other" })).rejects.toMatchObject({ code: "source_conflict" });
    expect(await handler.createAdapter("owner_a", project, { ...githubConfig, repo: "acme/other" })).toEqual({ ok: false, code: "config_invalid" });
    await expect(handler.saveConfig(scopeA, sourceId, githubConfig)).resolves.toBeUndefined();
    expect((await handler.createAdapter("owner_a", project, githubConfig)).ok).toBe(true);
    await harness.repository.applySyncBatch(scopeA, { sourceId: gitId, expectedCursor: "c1", nextCursor: "c2", deletions: [], upserts: [
      doc("commit", "git_commit", "https://github.com/acme"),
    ] });
    await expect(handler.saveConfig(scopeA, sourceId, { ...githubConfig, repo: "acme/other" })).resolves.toBeUndefined();
    expect(githubRepoOfPermalink("https://github.com/HamedMP/matrix-os/pull/2")).toBe("HamedMP/matrix-os");
    expect(["https://github.com/acme/../commit/x", "https://github.com/a b/c/d", "https://gitlab.com/a/b/c"].map(githubRepoOfPermalink))
      .toEqual([null, null, null]);
  });

  it("accepts any repository when the git source's repository is unknown", async () => {
    const handler = handlerWith();
    const sourceId = await newSource();
    await newSource("proj:proj_1", "git");
    await expect(handler.saveConfig(scopeA, sourceId, { ...githubConfig, repo: "acme/other" })).resolves.toBeUndefined();
    await harness.repository.eraseScope(scopeA);
    const again = await newSource();
    await newSource("https://github.com/acme/widgets/extra", "git");
    await expect(handler.saveConfig(scopeA, again, { ...githubConfig, repo: "acme/other", since: undefined })).resolves.toBeUndefined();
    expect(handler.viewConfig({ ...githubConfig, since: undefined })).toMatchObject({ since: null });
  });

  it("keeps at most eight listing validators per source, newest first", async () => {
    const sourceId = await newSource();
    const rows = githubConditionalRows(harness.db, scopeA, sourceId);
    const entries = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({
      key: (from + i).toString(16).padStart(64, "0"), validators: { etag: `"${from + i}"`, lastModified: null },
    }));
    await rows.persist(entries(0, 10), "f".repeat(64), true, new Date("2026-06-01T00:00:00Z"));
    await rows.persist(entries(100, 3), "f".repeat(64), true, new Date("2026-06-02T00:00:00Z"));
    await rows.persist([], "f".repeat(64), true, new Date("2026-06-03T00:00:00Z"));
    const stored = await harness.db.selectFrom("brain_github_conditional" as never).select("request_key" as never).execute();
    expect(stored).toHaveLength(8);
    expect(await rows.lookup((100).toString(16).padStart(64, "0"))).toEqual({ etag: '"100"', lastModified: null });
  });
});

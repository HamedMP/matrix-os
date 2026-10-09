/**
 * Model claims over the project API: the claims-v2 prompt and skip policy, then POST /extract {"extractor":"model"}
 * end to end on PGlite with the Claude client over a fake fetch (no network), the 409 without a credential, 404
 * before the provider, 503 when the provider fails, and no key in any response or log.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createBrainProjectService, startBrainProjectService } from "../../packages/gateway/src/brain/api/service.js";
import { createBrainRoutes } from "../../packages/gateway/src/brain/api/routes.js";
import {
  BRAIN_API_ERRORS, brainApiErrorBody, brainProjectScope, type BrainApiErrorCode, type BrainProjectLookup,
  type BrainProjectServiceDeps,
} from "../../packages/gateway/src/brain/api/index.js";
import {
  BRAIN_MODEL_DEFAULT_EXTRACTOR_ID, BRAIN_MODEL_PROMPT_MAX_CLAIMS, BRAIN_MODEL_PROMPT_VERSION, BRAIN_RULES_EXTRACTOR_ID,
  type BrainClaimModelProvider, type BrainModelEnv, type BrainModelFetch,
} from "../../packages/gateway/src/brain/claims/index.js";
import { createBrainClaimModelProvider } from "../../packages/gateway/src/brain/claims/model/config.js";
import {
  BRAIN_MODEL_SYSTEM_PROMPT, brainModelSkipCode, brainModelUserContent,
} from "../../packages/gateway/src/brain/claims/model/prompt.js";
import type { ProjectConfig } from "../../packages/gateway/src/project-manager.js";
import { brainContent, createBrainHarness, type BrainHarness } from "./helpers/brain-store-helpers.js";
import { errorResponse, fakeAnthropic, messageBody, SYNTHETIC_KEY } from "./helpers/brain-model-fetch.js";

const OWNER = "owner_a";
const PROJECT_ID = "proj_widgets";
const SCOPE = brainProjectScope(OWNER, PROJECT_ID);
const BASE = `/api/brain/projects/${PROJECT_ID}`;
const LEAK = /postgres|stack|\/home\/|stderr|relation |violates|sk-ant-/i;
const AT = "2026-10-01T10:00:00.000Z";
const PR_TITLE = "feat: alpha";
const PR_MESSAGE = ["feat: alpha (#12)", "", "## Summary",
  "- Moves claim storage into Postgres so every reader sees one copy of the truth.", "", "## Invariants",
  "- **Source of truth:** the brain_claims table; files are never read.",
  "- **Acceptable orphan states:** a running row until its lease expires.", "", "## Follow-ups",
  "- Alex will add retry metrics by 2026-11-01."].join("\n");
const PR_BODY = `${PR_MESSAGE}\n\nCommit: ${"a".repeat(40)}\nPull request: #12\nChanged paths: 1`;
const NOTE_BODY = "## Decisions\n- Keep one transaction per document.";
/** Long enough to be sent, and the newest document, but not synced from git: it must never reach the model. */
const CHAT_BODY = `## Decisions\n- ${"Private chat: we will move the launch to Friday because the vendor is late. ".repeat(4)}`;
const NO_FIELDS = { assignee: null, due: null, severity: null };
const WIRE_CLAIMS = [
  { kind: "invariant", label: "Source of truth", statement: "the brain_claims table; files are never read",
    quote: "**Source of truth:** the brain_claims table; files are never read.", fields: NO_FIELDS },
  { kind: "commitment", label: null, statement: "Alex will add retry metrics by 2026-11-01",
    quote: "Alex will add retry metrics by 2026-11-01.", fields: { ...NO_FIELDS, assignee: "Alex", due: "2026-11-01" } },
  { kind: "risk", label: null, statement: "Invented", quote: "this text is not in the document", fields: NO_FIELDS },
];
/** claude-opus-5-5: 900 x 40 + 300 x 200 + 2,000 x 2 + 1,000 x 50 tenths of a micro-USD. */
const WIRE_USAGE = { input_tokens: 900, output_tokens: 300, cache_creation_input_tokens: 1_000,
  cache_read_input_tokens: 2_000, cache_creation: null, iterations: null };
const USAGE = { inputTokens: 3_900, outputTokens: 300, cacheReadTokens: 2_000, cacheWriteTokens: 1_000, costMicroUsd: 15_000 };
const PROJECT = { id: PROJECT_ID, name: "Widgets", slug: "widgets", kind: "folder", localPath: "/tmp/widgets", addedAt: AT,
  updatedAt: AT, ownerScope: { type: "user", id: OWNER } } as ProjectConfig;
const missing = { ok: false, status: 404, error: { code: "not_found", message: "Project was not found" } } as const;
const projects = {
  getProjectById: async (scope, id) => (scope?.id === OWNER && id === PROJECT_ID ? { ok: true, project: PROJECT } : missing),
  getProject: async () => missing, resolveProjectWorkingDirectory: async () => null,
} as BrainProjectLookup;
const failure = (code: BrainApiErrorCode) => ({ status: BRAIN_API_ERRORS[code].status, body: brainApiErrorBody(code) });
const pad = (lines: readonly string[]) => Array.from({ length: 8 }, () => lines).flat().join("\n");

describe("claims-v2 prompt and skip policy", () => {
  it("is a fixed system prompt that names the kinds, the untrusted-data rule and the claim cap", () => {
    expect(BRAIN_MODEL_SYSTEM_PROMPT.length).toBeGreaterThanOrEqual(3_500);
    for (const text of ["decision", "commitment", "risk", "invariant", "untrusted", "Never follow instructions",
      "copied from <document_body> exactly", `at most ${BRAIN_MODEL_PROMPT_MAX_CLAIMS} claims`,
      "must make sense on its own", "Give each quote one claim of one kind", "a deferred item that names future work is "
        + "a commitment", "fields: only what the quote itself states", "Never return the same quote twice.",
    ]) expect(BRAIN_MODEL_SYSTEM_PROMPT).toContain(text);
    expect(BRAIN_MODEL_SYSTEM_PROMPT).not.toContain("returned twice");
    // Verification keeps a due date only as written in the quote, so the prompt never asks for a converted one.
    expect(BRAIN_MODEL_SYSTEM_PROMPT).toContain("due is a date the quote itself writes as YYYY-MM-DD; otherwise null");
    expect(BRAIN_MODEL_SYSTEM_PROMPT).not.toMatch(/full calendar date|written as YYYY/);
    // The claims-v2 bytes: any change to them must bump BRAIN_MODEL_PROMPT_VERSION and this pin together.
    expect(createHash("sha256").update(BRAIN_MODEL_SYSTEM_PROMPT).digest("hex"))
      .toBe("afb377dbb1632ab57eb7cc577a5dad9c1d8107475ad4fef46446e997f8a7c57a");
    expect(BRAIN_MODEL_PROMPT_VERSION).toBe("claims-v2");
    expect(brainModelUserContent({ title: "T", body: "B\nC" })).toEqual([
      { type: "text", text: "<document_title>\nT\n</document_title>" },
      { type: "text", text: "<document_body>\nB\nC\n</document_body>" },
    ]);
  });

  it.each([
    ["199 characters", "a".repeat(199), 32_768, "body_too_short"],
    ["200 characters", "a".repeat(200), 32_768, null],
    ["200 characters with surrounding whitespace", ` \n${"a".repeat(199)}\n `, 32_768, "body_too_short"],
    ["squash bullets and trailers", pad(["* fix the parser", "", "Co-authored-by: A <a@example.com>",
      "Signed-off-by: B <b@example.com>"]), 32_768, "commit_list_only"],
    ["squash bullets split by a rule", pad(["* fix the parser so it reads every line", "---"]), 32_768, "commit_list_only"],
    ["a written - list", pad(["- Keeps one transaction per document."]), 32_768, null],
    ["bullets with prose", pad(["* fix the parser", "Explains why the parser changed."]), 32_768, null],
    ["2,000 bytes over a 1,999-byte cap", "\u00e9".repeat(1_000), 1_999, "document_too_large"],
    ["2,000 bytes at a 2,000-byte cap", "\u00e9".repeat(1_000), 2_000, null],
  ])("%s", (_label, body, maxBytes, expected) => {
    expect(brainModelSkipCode(body, maxBytes)).toBe(expected);
  });
});

describe("model claims api", { timeout: 60_000 }, () => {
  let h: BrainHarness;
  let home: string;
  let errorLog: MockInstance<typeof console.error>;
  let warn: MockInstance<typeof console.warn>;
  beforeEach(async () => {
    h = await createBrainHarness();
    home = await mkdtemp(join(tmpdir(), "brain-model-service-"));
    errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const external = { kind: "git", externalRef: "https://github.com/acme/widgets", label: "Widgets" } as const;
    const { source: { sourceId } } = await h.repository.createSource(SCOPE, external);
    await h.repository.applySyncBatch(SCOPE, { sourceId, expectedCursor: null, nextCursor: "c1", deletions: [], upserts: [
      { ...brainContent("pr", { title: PR_TITLE, body: PR_BODY, provenance: "git_pr",
        permalink: "https://github.com/acme/widgets/pull/12", sourceUpdatedAt: "2026-09-02T00:00:00.000Z" }),
      refs: [{ kind: "path", value: "src/alpha.ts" }] },
      brainContent("note", { body: NOTE_BODY, provenance: "git_commit", sourceUpdatedAt: "2026-09-01T00:00:00.000Z" }),
      brainContent("chat", { body: CHAT_BODY, provenance: "matrix_chat", sourceUpdatedAt: "2026-09-03T00:00:00.000Z" }),
    ] });
  });
  afterEach(async () => {
    const logged = JSON.stringify([errorLog.mock.calls, warn.mock.calls]);
    errorLog.mockRestore();
    warn.mockRestore();
    await h.destroy();
    await rm(home, { recursive: true, force: true });
    expect(logged).not.toContain(SYNTHETIC_KEY);
  });

  const provider = (fetch: BrainModelFetch, env: BrainModelEnv = { ANTHROPIC_API_KEY: SYNTHETIC_KEY }) =>
    createBrainClaimModelProvider({ homePath: home, env, fetch });
  const app = (extra: Partial<BrainProjectServiceDeps> = {}): Hono => new Hono().route("/api/brain", createBrainRoutes({
    service: createBrainProjectService({ repository: h.repository, projects, homePath: home, ...extra }),
    getPrincipal: () => ({ userId: OWNER, source: "dev-default" }),
  }));

  async function call(target: Hono, path: string, body?: object): Promise<{ status: number; body: any }> {
    const init = body === undefined ? {}
      : { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } };
    const res = await target.request(`http://localhost${path}`, init);
    const text = await res.text();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(text).not.toMatch(LEAK);
    expect(text).not.toContain(SYNTHETIC_KEY);
    return { status: res.status, body: JSON.parse(text) };
  }

  it("runs one bounded model extraction next to rules claims, with tokens, cache counts and cost", async () => {
    const fake = fakeAnthropic(() => Response.json(messageBody({ claims: WIRE_CLAIMS, usage: WIRE_USAGE })));
    const api = app({ claimModels: provider(fake.fetch) });
    expect(await call(api, `${BASE}/extract`, {})).toMatchObject({ status: 200, body: { extractor: BRAIN_RULES_EXTRACTOR_ID } });

    const extracted = await call(api, `${BASE}/extract`, { extractor: "model" });
    expect(extracted).toMatchObject({ status: 200, body: {
      status: "succeeded", errorCode: null, nextAction: "", caughtUp: true, extractor: BRAIN_MODEL_DEFAULT_EXTRACTOR_ID,
      counts: { documentsProcessed: 2, documentsFailed: 0, claimsWritten: 2, quotesRejected: 1 },
      run: { status: "succeeded", extractor: BRAIN_MODEL_DEFAULT_EXTRACTOR_ID, usage: USAGE },
    } });
    expect(extracted.body.usage).toEqual(USAGE);
    // The run reports the 30-day window it checked (default cap 5 USD), like GET .../claims does.
    expect(extracted.body.spend).toMatchObject({ capMicroUsd: 5_000_000, spentMicroUsd: expect.any(Number) });
    // Only the pull request is sent: the commit is too short and the chat is not from git. Title and footer-stripped
    // body, nothing else.
    expect(fake.requests).toHaveLength(1);
    expect(JSON.stringify(fake.requests.map((sent) => sent.body))).not.toContain("Private chat");
    const [request] = fake.requests;
    expect(request!.headers.get("x-api-key") === SYNTHETIC_KEY).toBe(true);
    expect(request!.body.messages).toEqual([{ role: "user", content: brainModelUserContent({ title: PR_TITLE, body: PR_MESSAGE }) }]);
    expect(JSON.stringify(request!.body)).not.toMatch(/owner_a|proj_widgets|personal:|Commit: a|github\.com|src\/alpha/);

    const items = (await call(api, `${BASE}/claims?limit=100`)).body.items;
    const model = items.filter((item: any) => item.extractor === BRAIN_MODEL_DEFAULT_EXTRACTOR_ID);
    expect(items.some((item: any) => item.extractor === BRAIN_RULES_EXTRACTOR_ID)).toBe(true);
    expect(model.map((item: any) => [item.kind, item.label, item.quote, item.fields, item.confidence]).sort()).toEqual([
      ["commitment", null, "Alex will add retry metrics by 2026-11-01.", { assignee: "Alex", due: "2026-11-01" }, "medium"],
      ["invariant", "Source of truth", "**Source of truth:** the brain_claims table; files are never read.", {}, "medium"],
    ]);
    expect(model[0].document).toMatchObject({ kind: "pr", label: "#12", title: PR_TITLE });

    // Caught up: the skipped note and the done pull request are not sent again.
    expect((await call(api, `${BASE}/extract`, { extractor: "model" })).body)
      .toMatchObject({ caughtUp: true, counts: { documentsProcessed: 0 } });
    expect(fake.requests).toHaveLength(1);
  });

  it("records a refusal as a skipped document and an API failure as a failed run, both as 200s", async () => {
    let refuse = true;
    const fake = fakeAnthropic(() => refuse
      ? Response.json(messageBody({ content: [], stopReason: "refusal", usage: WIRE_USAGE }))
      : errorResponse(401, "authentication_error"));
    const api = app({ claimModels: provider(fake.fetch) });
    expect((await call(api, `${BASE}/extract`, { extractor: "model" })).body).toMatchObject({
      status: "succeeded", usage: USAGE, counts: { documentsProcessed: 2, documentsFailed: 0, claimsWritten: 0 },
    });
    const states = await h.db.selectFrom("brain_extraction_state").select(["status", "error_code"]).orderBy("error_code").execute();
    expect(states).toEqual([{ status: "skipped", error_code: "body_too_short" }, { status: "skipped", error_code: "model_refused" }]);

    refuse = false;
    await h.db.deleteFrom("brain_extraction_state").execute();
    expect(await call(api, `${BASE}/extract`, { extractor: "model" })).toMatchObject({ status: 200, body: {
      status: "failed", errorCode: "model_auth_failed", nextAction: "configure_model", counts: { documentsProcessed: 0 },
      run: { status: "failed", errorCode: "model_auth_failed" },
    } });
  });

  it("answers 409 extractor_not_configured without a usable credential or without a provider", async () => {
    const fake = fakeAnthropic(() => Response.json(messageBody({ claims: [] })));
    for (const env of [{}, { ANTHROPIC_API_KEY: "sk-proxy-synthetic" }, { ANTHROPIC_API_KEY: "sk-ant-oat01-synthetic" },
      { ANTHROPIC_API_KEY: SYNTHETIC_KEY, ANTHROPIC_BASE_URL: "https://relay.example.com" }]) {
      expect(await call(app({ claimModels: provider(fake.fetch, env) }), `${BASE}/extract`, { extractor: "model" }))
        .toEqual(failure("extractor_not_configured"));
    }
    expect(await call(app(), `${BASE}/extract`, { extractor: "model" })).toEqual(failure("extractor_not_configured"));
    expect(fake.requests).toHaveLength(0);
    expect(await h.db.selectFrom("brain_extraction_runs").select("run_id").execute()).toEqual([]);
  });

  it("runs the model only for the gateway owner's principals; any other gets 409 and no budget", async () => {
    const fake = fakeAnthropic(() => Response.json(messageBody({ claims: [] })));
    const deps = { claimModels: provider(fake.fetch), modelSpendCapMicroUsd: 5_000_000 };
    const other = app({ ...deps, modelOwnerIds: ["owner_elsewhere"] });
    expect(await call(other, `${BASE}/extract`, { extractor: "model" })).toEqual(failure("extractor_not_configured"));
    expect((await call(other, `${BASE}/claims`)).body.modelSpend).toBeNull();
    expect(fake.requests).toHaveLength(0);
    expect(await h.db.selectFrom("brain_extraction_runs").select("run_id").execute()).toEqual([]);
    const owner = app({ ...deps, modelOwnerIds: [OWNER] });
    expect((await call(owner, `${BASE}/claims`)).body.modelSpend).toMatchObject({ capMicroUsd: 5_000_000 });
    expect((await call(owner, `${BASE}/extract`, { extractor: "model" })).status).toBe(200);
    expect(fake.requests.length).toBeGreaterThan(0);
  });

  it("stops a model run on the caller's signal: no call after it aborts, and the call in flight is aborted", async () => {
    const hanging = fakeAnthropic(() => "hang");
    const service = createBrainProjectService({
      repository: h.repository, projects, homePath: home, claimModels: provider(hanging.fetch),
    });
    const before = await service.extract(OWNER, PROJECT_ID, { extractor: "model" }, AbortSignal.abort());
    expect(before).toMatchObject({ counts: { documentsProcessed: 0 }, caughtUp: false });
    expect(hanging.requests).toHaveLength(0);
    const controller = new AbortController();
    setTimeout(() => controller.abort("cancelled"), 50);
    const during = await service.extract(OWNER, PROJECT_ID, { extractor: "model" }, controller.signal);
    expect(during).toMatchObject({ counts: { documentsProcessed: 0 }, caughtUp: false });
    expect(hanging.requests).toHaveLength(1);
    expect(hanging.requests[0]!.signal?.aborted).toBe(true);
    // The call in flight may still be billed: it counts at its worst case.
    expect(during.usage.costMicroUsd).toBeGreaterThan(0);
  });

  it("uses the owner's key from config.json before the environment", async () => {
    const ownerKey = "sk-ant-api03-owner-synthetic";
    await mkdir(join(home, "system"), { recursive: true });
    await writeFile(join(home, "system/config.json"), JSON.stringify({ kernel: { anthropicApiKey: ownerKey } }));
    const fake = fakeAnthropic(() => Response.json(messageBody({ claims: [] })));
    expect((await call(app({ claimModels: provider(fake.fetch) }), `${BASE}/extract`, { extractor: "model" })).status).toBe(200);
    expect(fake.requests.map((request) => request.headers.get("x-api-key") === ownerKey)).toEqual([true]);
  });

  it("resolves the project before the model: 404 for a missing project, 503 when the provider fails", async () => {
    const claimModels = vi.fn<BrainClaimModelProvider>(async () => null);
    expect(await call(app({ claimModels }), "/api/brain/projects/proj_other/extract", { extractor: "model" }))
      .toEqual(failure("project_not_found"));
    expect(claimModels).not.toHaveBeenCalled();
    const broken = vi.fn<BrainClaimModelProvider>(async () => { throw new Error(`EACCES ${SYNTHETIC_KEY} /home/x`); });
    expect(await call(app({ claimModels: broken }), `${BASE}/extract`, { extractor: "model" })).toEqual(failure("brain_unavailable"));
    expect(errorLog).toHaveBeenCalledWith("[brain-api] Request failed:", "Error");
    // Rules runs never ask for a model.
    expect((await call(app({ claimModels: broken }), `${BASE}/extract`, { extractor: "rules" })).status).toBe(200);
    expect(broken).toHaveBeenCalledTimes(1);
  });

  it("lists claims with the default provider's 30-day cap, and no cap for an off model or a given provider", async () => {
    vi.stubEnv("MATRIX_BRAIN_MODEL_SPEND_MICROUSD_PER_30D", "2000000");
    try {
      const started = await startBrainProjectService(h.db, { projects, homePath: home });
      expect((await started!.listClaims(OWNER, PROJECT_ID, { limit: 1 })).modelSpend).toMatchObject({
        capMicroUsd: 2_000_000, spentMicroUsd: 0, remainingMicroUsd: 2_000_000,
      });
      // An invalid setting turns the model off, so there is no cap to show.
      vi.stubEnv("MATRIX_BRAIN_MODEL_SPEND_MICROUSD_PER_30D", "0");
      const off = await startBrainProjectService(h.db, { projects, homePath: home });
      expect((await off!.listClaims(OWNER, PROJECT_ID, { limit: 1 })).modelSpend).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
    const given = await startBrainProjectService(h.db, {
      projects, homePath: home, claimModels: vi.fn<BrainClaimModelProvider>(async () => null),
    });
    expect((await given!.listClaims(OWNER, PROJECT_ID, { limit: 1 })).modelSpend).toBeNull();
  });

  it("passes a given provider through startBrainProjectService", async () => {
    const claimModels = vi.fn<BrainClaimModelProvider>(async () => null);
    const service = await startBrainProjectService(h.db, { projects, homePath: home, claimModels });
    await expect(service!.extract(OWNER, PROJECT_ID, { extractor: "model" })).rejects.toMatchObject({ code: "extractor_not_configured" });
    expect(claimModels).toHaveBeenCalledTimes(1);
  });
});

/**
 * Impact brief service over a real fixture repository and a PGlite brain: git source sync, hand-seeded claims, and
 * every view section, notice and error the service can produce.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainApiError, brainProjectScope } from "../../packages/gateway/src/brain/api/types.js";
import {
  BrainFeatureError, type BrainImpactService, type BrainImpactView,
} from "../../packages/gateway/src/brain/contracts.js";
import { defaultGitRunner, syncGitSource } from "../../packages/gateway/src/brain/git/index.js";
import { GitRunnerError, type GitRunner } from "../../packages/gateway/src/brain/git/types.js";
import { currentClaims, priorPullRequests, specCites } from "../../packages/gateway/src/brain/impact/brain.js";
import { createBrainImpactService } from "../../packages/gateway/src/brain/impact/index.js";
import { IMPACT_MAX_CONCURRENT_BRIEFS } from "../../packages/gateway/src/brain/impact/service.js";
import type { BrainScopeKey } from "../../packages/gateway/src/brain/types.js";
import {
  FIXTURE_WEB_BASE, createBrainGitFixture, fakeRunner, gitRunResult, type BrainGitFixture,
} from "./helpers/brain-git-fixture.js";
import { fixtureDocumentId } from "./helpers/brain-git-harness.js";
import {
  IMPACT_OWNER, IMPACT_PROJECT, IMPACT_SCOPE, buildImpactHistory, fakeResolver, impactDocumentId, seedClaims,
  type ImpactHistory,
} from "./helpers/brain-impact-fixture.js";
import { dropCites } from "./helpers/brain-cite-fakes.js";
import { createBrainHarness, type BrainHarness } from "./helpers/brain-store-helpers.js";

let fixture: BrainGitFixture;
let harness: BrainHarness;
let history: ImpactHistory;
/** Later than every fixture commit: currentClaims reads documents dated at or before it. */
const AS_OF = "2100-01-01T00:00:00.000Z";

function service(options: { runner?: GitRunner; now?: () => number; checkout?: string | null } = {}): BrainImpactService {
  const checkout = options.checkout === undefined ? fixture.repoPath : options.checkout;
  return createBrainImpactService({
    repository: harness.repository, resolver: fakeResolver(fixture.homePath, checkout),
    runner: options.runner, now: options.now,
  });
}

async function connectAndSync(): Promise<string> {
  const { source } = await harness.repository.createSource(IMPACT_SCOPE, {
    kind: "git", externalRef: FIXTURE_WEB_BASE, label: "widgets",
  });
  const result = await syncGitSource({
    repository: harness.repository, scope: IMPACT_SCOPE, sourceId: source.sourceId, repoPath: fixture.repoPath,
    homePath: fixture.homePath, config: {},
  });
  expect(result.status).toBe("succeeded");
  return source.sourceId;
}

async function specDocumentId(): Promise<string> {
  return (await harness.repository.listDocumentsByRef(IMPACT_SCOPE, {
    kind: "spec", value: "specs/001-alpha", mode: "exact_or_under", provenances: ["git_spec"],
  })).items[0]!.document.documentId;
}

/**
 * Documents and claims in another scope that would change a brief if any read crossed scopes: a newer pull request
 * and spec on the changed paths, and "shadow" documents reusing this scope's ids with other path and handle refs.
 */
async function plantElsewhere(scope: BrainScopeKey, tag: string, shadows: { pr: string; spec: string }) {
  const { source } = await harness.repository.createSource(scope, { kind: "github", externalRef: "acme/w", label: "G" });
  const pr = impactDocumentId(`pr-${tag}`);
  const spec = impactDocumentId(`spec-${tag}`);
  const doc = (documentId: string, provenance: string, body: string, refs: Array<{ kind: string; value: string }>) => ({
    documentId, title: `Elsewhere ${tag}`, body, permalink: "", sourceUpdatedAt: "2026-08-30T00:00:00.000Z", provenance,
    refs,
  });
  await harness.repository.applySyncBatch(scope, {
    sourceId: source.sourceId, expectedCursor: null, nextCursor: "c1", deletions: [], upserts: [
      doc(pr, "github_pr", `Other rule ${tag}. Other choice ${tag}.`, [
        { kind: "path", value: "packages/core/src/alpha.ts" }, { kind: "handle", value: `#9${tag}` }]),
      doc(spec, "git_spec", `Other spec rule ${tag}.`, [
        { kind: "path", value: "specs/001-alpha/spec.md" }, { kind: "spec", value: "specs/001-alpha" }]),
      doc(shadows.pr, "manual", `Shadow rule ${tag}.`, [{ kind: "path", value: "packages/core/src/beta.ts" }]),
      doc(shadows.spec, "manual", "Shadow spec.", [{ kind: "handle", value: "#0" }]),
    ],
  });
  await seedClaims(harness.repository, scope, [
    { documentId: pr, kind: "invariant", quote: `Other rule ${tag}.` },
    { documentId: pr, kind: "decision", quote: `Other choice ${tag}.` },
    { documentId: spec, kind: "invariant", quote: `Other spec rule ${tag}.` },
    { documentId: shadows.pr, kind: "invariant", quote: `Shadow rule ${tag}.` },
  ]);
  return { pr, spec };
}

const citedIds = (view: BrainImpactView): string[] => [
  ...view.prior.flatMap((item) => item.items), ...view.invariants.map((claim) => claim.cite),
  ...view.decisions.map((claim) => claim.cite), ...view.specs.flatMap((item) => (item.cite === null ? [] : [item.cite])),
].map((cite) => cite.documentId);

async function expectCode(promise: Promise<unknown>, type: typeof BrainApiError | typeof BrainFeatureError, code: string) {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(type);
  expect((error as BrainApiError).code).toBe(code);
}

beforeEach(async () => {
  fixture = await createBrainGitFixture();
  harness = await createBrainHarness();
  history = await buildImpactHistory(fixture);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.destroy();
  await fixture.destroy();
});

describe("impact brief", { timeout: 120_000 }, () => {
  it("reports changes, dependents, history, claims, untested code and specs", async () => {
    await connectAndSync();
    const pr1 = fixtureDocumentId("pr", 1);
    const spec = await specDocumentId();
    await seedClaims(harness.repository, IMPACT_SCOPE, [
      { documentId: pr1, kind: "invariant", quote: "Alpha stays bounded." },
      { documentId: pr1, kind: "decision", quote: "Alpha uses plain numbers.", label: "Numbers" },
      { documentId: spec, kind: "invariant", quote: "Alpha stays a number." },
    ]);
    await seedClaims(harness.repository, IMPACT_SCOPE, [
      { documentId: pr1, kind: "invariant", quote: "Alpha stays bounded." },
    ], "model:claude-opus-5-5/claims-v2");
    const { source: github } = await harness.repository.createSource(IMPACT_SCOPE, {
      kind: "github", externalRef: "acme/widgets", label: "GitHub",
    });
    const githubPr = (seed: string, handle: string, at: string) => ({
      documentId: impactDocumentId(seed), title: `GitHub ${seed}`, body: "Alpha stays bounded.", permalink: "",
      sourceUpdatedAt: at, provenance: "github_pr", refs: [
        { kind: "path", value: "packages/core/src/alpha.ts" }, { kind: "handle", value: handle },
        { kind: "spec", value: "specs/001-alpha" },
      ],
    });
    await harness.repository.applySyncBatch(IMPACT_SCOPE, {
      sourceId: github.sourceId, expectedCursor: null, nextCursor: "c1", deletions: [],
      upserts: [githubPr("same", "#1", "2026-08-31T00:00:00.000Z"), githubPr("seven", "#7", "2026-08-01T00:00:00.000Z")],
    });
    await seedClaims(harness.repository, IMPACT_SCOPE, [
      { documentId: impactDocumentId("seven"), kind: "invariant", quote: "Alpha stays bounded." },
    ]);

    const view = await service().impact(IMPACT_OWNER, IMPACT_PROJECT, { head: "feature", depth: 2 });

    expect(view.base).toEqual({ ref: "main", sha: history.mainTip });
    expect(view.head).toEqual({ ref: "feature", sha: history.feature });
    expect(view.mergeBase).toBe(history.mainTip);
    expect(view.changedTotal).toBe(12);
    expect(view.changedFiles).toContainEqual({
      path: "packages/core/src/util/text.ts", status: "renamed", previousPath: "packages/core/src/util/strings.ts",
      isTest: false,
    });
    expect(view.changedFiles).toContainEqual({
      path: "packages/app/src/legacy.ts", status: "deleted", previousPath: null, isTest: false,
    });
    expect(view.changedFiles).toContainEqual({
      path: "tests/app/config.test.ts", status: "added", previousPath: null, isTest: true,
    });
    // Depth first, then files importing more changed files (lazy.js and index.ts import two each), then path.
    expect(view.dependents).toEqual([
      { path: "packages/app/src/lazy.js", depth: 1, via: "packages/app/src/widgets/index.tsx" },
      { path: "packages/core/src/index.ts", depth: 1, via: "packages/core/lib/gamma.ts" },
      { path: "packages/app/src/main.ts", depth: 1, via: "packages/core/src/util/strings.ts" },
      { path: "packages/app/src/uses-legacy.ts", depth: 1, via: "packages/app/src/legacy.ts" },
      { path: "tests/core/alpha.test.ts", depth: 1, via: "packages/core/src/alpha.ts" },
      { path: "packages/app/src/deep.ts", depth: 2, via: "packages/app/src/main.ts" },
    ]);
    expect(view.dependentTotals).toEqual({ depth1: 5, depth2: 1 });
    expect(view.approximate).toBe(true);
    const alphaPrior = view.prior.find((item) => item.path === "packages/core/src/alpha.ts")!;
    expect(alphaPrior.items.map((item) => [item.label, item.kind, item.provenance])).toEqual([
      ["#1", "pr", "git_pr"], ["#7", "pr", "github_pr"],
    ]);
    expect(alphaPrior.items[0]!.permalink).toBe(`${FIXTURE_WEB_BASE}/pull/1`);
    expect(view.prior.map((item) => item.path)).toContain("packages/core/src/util/strings.ts");
    expect(view.invariants.map((claim) => [claim.statement, claim.cite.label, claim.paths])).toEqual([
      ["Alpha stays bounded.", "#1", ["packages/core/src/alpha.ts", "packages/core/src/util/strings.ts"]],
      ["Alpha stays a number.", "specs/001-alpha", ["specs/001-alpha/spec.md"]],
    ]);
    expect(view.decisions).toMatchObject([{ kind: "decision", label: "Numbers", statement: "Alpha uses plain numbers." }]);
    expect(view.untested).toEqual([
      { path: "packages/app/src/widgets/index.tsx" }, { path: "packages/core/src/alpha.ts" },
      { path: "packages/core/src/beta.ts" }, { path: "packages/core/src/util/text.ts" },
    ]);
    expect(view.specs).toMatchObject([{
      spec: "specs/001-alpha", changedPaths: ["specs/001-alpha/spec.md"], cite: { kind: "spec", label: "specs/001-alpha" },
    }]);
    expect(view.notices).toEqual([]);
    const one = await currentClaims(harness.db, IMPACT_SCOPE, ["packages/core/src/alpha.ts"], "invariant", 1, AS_OF);
    expect(one.map((claim) => claim.statement)).toEqual(["Alpha stays bounded."]);
    // A document tombstoned between a page read and its cite read is left out, never shown without a cite.
    const racing = harness.db.withPlugin(dropCites());
    const alpha = ["packages/core/src/alpha.ts"];
    expect(await currentClaims(racing, IMPACT_SCOPE, alpha, "invariant", 1, AS_OF)).toEqual([]);
    expect(await priorPullRequests(racing, IMPACT_SCOPE, alpha, 2, 10, AS_OF)).toEqual([]);
    expect(await specCites(racing, IMPACT_SCOPE, ["specs/001-alpha"])).toEqual(new Map());
  });

  it("adds depth 2 by default, stops at depth 1 when asked and formats the comment", async () => {
    await connectAndSync();
    const impact = service();
    const view = await impact.impact(IMPACT_OWNER, "widgets", { head: "feature" });
    expect(view.dependents.map((item) => item.depth)).toEqual([1, 1, 1, 1, 1, 2]);
    expect(view.dependentTotals).toEqual({ depth1: 5, depth2: 1 });
    const direct = await impact.impact(IMPACT_OWNER, "widgets", { head: "feature", depth: 1 });
    expect(direct.dependents.every((item) => item.depth === 1)).toBe(true);
    expect(direct.dependentTotals).toEqual({ depth1: 5, depth2: null });
    const comment = await impact.comment(IMPACT_OWNER, IMPACT_PROJECT, { head: "feature" });
    expect(comment.truncated).toBe(false);
    expect(comment.markdown).toContain("#### Earlier pull requests");
    expect(comment.markdown).toContain(`[#\u200b1](${FIXTURE_WEB_BASE}/pull/1)`);
  });

  it("never lists a synced range's own pull requests or claims as earlier work", async () => {
    await connectAndSync();
    await seedClaims(harness.repository, IMPACT_SCOPE, [
      { documentId: fixtureDocumentId("pr", 1), kind: "invariant", quote: "Alpha stays bounded." },
    ]);
    const inside = await service().impact(IMPACT_OWNER, IMPACT_PROJECT, { head: "main", base: history.root.slice(0, 7) });
    expect(inside.mergeBase).toBe(history.root);
    expect(inside.prior.flatMap((item) => item.items.map((cite) => cite.label))).not.toContain("#1");
    expect(inside.invariants.map((claim) => claim.statement)).not.toContain("Alpha stays bounded.");
    const after = await service().impact(IMPACT_OWNER, IMPACT_PROJECT, { head: "feature" });
    expect(after.invariants.map((claim) => claim.statement)).toContain("Alpha stays bounded.");
  });

  it("never reads another owner's or another project's brain", async () => {
    await connectAndSync();
    const pr1 = fixtureDocumentId("pr", 1);
    const spec = await specDocumentId();
    await seedClaims(harness.repository, IMPACT_SCOPE, [
      { documentId: pr1, kind: "invariant", quote: "Alpha stays bounded." },
      { documentId: pr1, kind: "decision", quote: "Alpha uses plain numbers." },
    ]);
    const ask = (ownerId: string) => service().impact(ownerId, IMPACT_PROJECT, { head: "feature" });
    const before = await ask(IMPACT_OWNER);
    const ownerB = await plantElsewhere(brainProjectScope("owner_b", IMPACT_PROJECT), "0", { pr: pr1, spec });
    const project = await plantElsewhere(brainProjectScope(IMPACT_OWNER, "proj_other"), "1", { pr: pr1, spec });

    const after = await ask(IMPACT_OWNER);
    expect(after).toEqual(before);
    expect(new Set(citedIds(after))).toEqual(new Set([pr1, spec]));
    for (const id of [ownerB.pr, ownerB.spec, project.pr, project.spec]) expect(citedIds(after)).not.toContain(id);
    expect(after.prior.find((item) => item.path === "packages/core/src/alpha.ts")!.items.map((cite) => cite.label))
      .toEqual(["#1"]);
    expect(after.invariants.map((claim) => [claim.statement, claim.paths])).toEqual([
      ["Alpha stays bounded.", ["packages/core/src/alpha.ts", "packages/core/src/util/strings.ts"]],
    ]);
    expect(after.decisions.map((claim) => claim.statement)).toEqual(["Alpha uses plain numbers."]);
    expect(after.specs.map((item) => [item.cite?.documentId, item.cite?.label])).toEqual([[spec, "specs/001-alpha"]]);

    const theirs = await ask("owner_b");
    expect(theirs.prior.flatMap((item) => item.items.map((cite) => [cite.documentId, cite.label])))
      .toEqual([[ownerB.pr, "#90"]]);
    expect(theirs.invariants.map((claim) => `${claim.statement} ${claim.paths.join(",")}`).sort()).toEqual([
      "Other rule 0. packages/core/src/alpha.ts", "Other spec rule 0. specs/001-alpha/spec.md",
      "Shadow rule 0. packages/core/src/beta.ts",
    ]);
    expect(theirs.decisions.map((claim) => claim.statement)).toEqual(["Other choice 0."]);
    expect(theirs.specs.map((item) => item.cite?.documentId)).toEqual([ownerB.spec]);
    expect(theirs.notices).toEqual(["no_git_source"]);
  });

  it("says when the project has no git source or the brain is behind the merge base", async () => {
    const none = await service().impact(IMPACT_OWNER, IMPACT_PROJECT, { head: "feature" });
    expect(none.notices).toEqual(["no_git_source"]);
    expect(none.prior).toEqual([]);
    expect(none.specs[0]!.cite).toBeNull();

    const { source } = await harness.repository.createSource(IMPACT_SCOPE, {
      kind: "git", externalRef: FIXTURE_WEB_BASE, label: "w",
    });
    harness.tick();
    await harness.repository.createSource(IMPACT_SCOPE, { kind: "git", externalRef: "project:proj_widgets", label: "x" });
    const unsynced = await service().impact(IMPACT_OWNER, IMPACT_PROJECT, { head: "feature" });
    expect(unsynced.notices).toEqual(["brain_behind_head"]);
    await harness.repository.applySyncBatch(IMPACT_SCOPE, {
      sourceId: source.sourceId, expectedCursor: null, nextCursor: "not-a-cursor", upserts: [], deletions: [],
    });
    const unknown = await service().impact(IMPACT_OWNER, IMPACT_PROJECT, { head: "feature" });
    expect(unknown.notices).toEqual(["brain_behind_head"]);
    const empty = await service().impact(IMPACT_OWNER, IMPACT_PROJECT, { head: "main" });
    expect([empty.changedFiles, empty.dependents, empty.prior, empty.invariants, empty.specs, empty.notices])
      .toEqual([[], [], [], [], [], ["brain_behind_head"]]);
  });

  it("flags a sync position that does not contain the merge base", async () => {
    await connectAndSync();
    const newer = await fixture.commit({ message: "chore: later", files: { "docs/later.md": "Later.\n" } });
    await fixture.commit({ branch: "late", parents: [newer], message: "feat: late", files: { "docs/late.md": "x\n" } });
    const view = await service().impact(IMPACT_OWNER, IMPACT_PROJECT, { head: "late", base: "main" });
    expect(view.mergeBase).toBe(newer);
    expect(view.notices).toEqual(["brain_behind_head"]);
    const same = await service().impact(IMPACT_OWNER, IMPACT_PROJECT, { head: history.feature, base: history.mainTip });
    expect(same.notices).toEqual([]);
    expect(same.head.ref).toBe(history.feature);
  });

  it("caps changed files and stops the scan at the run budget", async () => {
    const diff = Array.from({ length: 501 }, (_, i) => `A\u0000src/f${i}.ts\u0000`).join("");
    const runner = fakeRunner(defaultGitRunner, (sub) => (sub[0] === "diff" ? gitRunResult(diff) : undefined));
    let clock = 0;
    const view = await service({ runner, now: () => (clock += 30_000) }).impact(IMPACT_OWNER, IMPACT_PROJECT, { head: "feature" });
    expect(view.changedFiles).toHaveLength(500);
    expect(view.changedTotal).toBe(501);
    expect(view.dependents).toEqual([]);
    expect(view.notices).toEqual(["changed_files_capped", "run_budget_exhausted", "no_git_source"]);
  });
});

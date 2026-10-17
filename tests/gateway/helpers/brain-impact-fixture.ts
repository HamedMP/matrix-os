/**
 * Impact brief fixtures: a two-package TypeScript workspace on main with one squash PR, a feature branch that changes,
 * adds, renames and deletes files, a fake project resolver and a helper that stores hand-written claims through the
 * extraction store API (no extractor runs).
 */
import { createHash } from "node:crypto";
import { BrainApiError, brainProjectScope } from "../../../packages/gateway/src/brain/api/types.js";
import {
  BRAIN_RULES_EXTRACTOR_ID, computeBrainClaimId, type BrainClaimKind,
} from "../../../packages/gateway/src/brain/claims/types.js";
import type { BrainProjectResolver } from "../../../packages/gateway/src/brain/contracts.js";
import type { BrainRepository } from "../../../packages/gateway/src/brain/repository.js";
import type { BrainScopeKey } from "../../../packages/gateway/src/brain/types.js";
import type { BrainGitFixture } from "./brain-git-fixture.js";

export const IMPACT_OWNER = "owner_a";
export const IMPACT_PROJECT = "proj_widgets";
export const IMPACT_SCOPE: BrainScopeKey = brainProjectScope(IMPACT_OWNER, IMPACT_PROJECT);
export const PR1_BODY = "## Summary\n- Adds alpha.\n\n## Invariants\n- Alpha stays bounded.\n\n## Decisions\n"
  + "- Alpha uses plain numbers.";
export const SPEC_TEXT = "# Alpha\n\n## Invariants\n- Alpha stays a number.\n";

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const MAIN_FILES = {
  "package.json": json({ name: "widgets", private: true }),
  "packages/core/package.json": json({
    name: "@acme/core",
    exports: { ".": { types: "./src/index.ts", import: "./dist/index.js" }, "./util/*": "./src/util/*.ts" },
  }),
  "packages/core/src/index.ts": "export * from \"./alpha.js\";\nexport { gamma } from \"../lib/gamma\";\n",
  "packages/core/src/alpha.ts": "export const alpha = 0;\n",
  "packages/core/lib/gamma.ts": "export const gamma = 3;\n",
  "packages/core/src/util/strings.ts": "export const upper = (value: string) => value.toUpperCase();\n",
  "packages/app/package.json": json({ name: "@acme/app", main: "./src/main.ts" }),
  "packages/app/src/main.ts": "import { alpha } from \"@acme/core\";\nimport { upper } from \"@acme/core/util/strings\";\n"
    + "export const main = () => upper(String(alpha));\n",
  "packages/app/src/deep.ts": "import { main } from \"./main\";\nexport const deep = main;\n",
  "packages/app/src/widgets/index.tsx": "export const Widget = () => null;\n",
  "packages/app/src/lazy.js": "export const load = () => import(\"./widgets\");\n"
    + "const legacy = require(\"../../core/lib/gamma.js\");\n",
  "packages/app/src/config.ts": "export const config = {};\n",
  "packages/app/src/legacy.ts": "export const legacy = true;\n",
  "packages/app/src/uses-legacy.ts": "import { legacy } from './legacy.js';\nexport const usesLegacy = legacy;\n",
  "tests/core/alpha.test.ts": "import { alpha } from \"../../packages/core/src/alpha.js\";\n",
  "specs/001-alpha/spec.md": SPEC_TEXT,
  "docs/notes.md": "Notes.\n",
} as const;

export interface ImpactHistory {
  readonly root: string; readonly pr1: string; readonly mainTip: string; readonly feature: string;
}

/** main: root, PR #1 (alpha + strings), a docs commit. feature (from main): every kind of change. */
export async function buildImpactHistory(f: BrainGitFixture): Promise<ImpactHistory> {
  const root = await f.commit({ message: "Initial commit", files: MAIN_FILES });
  const pr1 = await f.squashPr(1, "feat(core): alpha", PR1_BODY, {
    "packages/core/src/alpha.ts": "export const alpha = 1;\n",
    "packages/core/src/util/strings.ts": "export const upper = (value: string): string => value.toUpperCase();\n",
  });
  const mainTip = await f.commit({ message: "docs: notes", files: { "docs/notes.md": "More notes.\n" } });
  const feature = await f.commit({
    branch: "feature", parents: [mainTip], message: "feat: beta",
    files: {
      "packages/core/src/alpha.ts": "export const alpha = 2;\n",
      "packages/core/src/beta.ts": "export const beta = 2;\n",
      "packages/core/src/util/strings.ts": null,
      "packages/core/src/util/text.ts": "export const upper = (value: string): string => value.toUpperCase();\n",
      "packages/core/lib/gamma.ts": "export const gamma = 4;\n",
      "packages/core/lib/gamma.test.ts": "import { gamma } from \"./gamma.js\";\n",
      "packages/core/src/delta.ts": "export const delta = 4;\n",
      "tests/misc/core-delta.test.ts": "import { delta } from \"../../packages/core/src/delta.js\";\n",
      "packages/app/src/config.ts": "export const config = { on: true };\n",
      "packages/app/src/widgets/index.tsx": "export const Widget = () => 'w';\n",
      "tests/app/config.test.ts": "import { config } from \"../../packages/app/src/config.js\";\n",
      "packages/app/src/legacy.ts": null,
      "specs/001-alpha/spec.md": `${SPEC_TEXT}\n## Decisions\n- Keep alpha small.\n`,
    },
  });
  return { root, pr1, mainTip, feature };
}

export function fakeResolver(homePath: string, checkout: string | null): BrainProjectResolver {
  return {
    homePath,
    async resolve(ownerId, projectRef) {
      if (projectRef !== IMPACT_PROJECT && projectRef !== "widgets") throw new BrainApiError("project_not_found");
      return { projectId: IMPACT_PROJECT, slug: "widgets", name: "Widgets", scope: brainProjectScope(ownerId, IMPACT_PROJECT) };
    },
    async checkoutPath() {
      return checkout;
    },
  };
}

export interface ClaimSeed {
  readonly documentId: string; readonly kind: BrainClaimKind; readonly quote: string; readonly label?: string;
}

/** One closed run of `extractor` storing the seeds (quote located verbatim in the live body). */
export async function seedClaims(
  repository: BrainRepository, scope: BrainScopeKey, seeds: readonly ClaimSeed[], extractor = BRAIN_RULES_EXTRACTOR_ID,
): Promise<void> {
  const run = await repository.openExtractionRun(scope, { extractor });
  for (const documentId of [...new Set(seeds.map((seed) => seed.documentId))]) {
    const document = (await repository.getDocument(scope, documentId))!;
    const claims = seeds.filter((seed) => seed.documentId === documentId).map((seed) => {
      const spanStart = document.body.indexOf(seed.quote);
      if (spanStart === -1) throw new Error(`quote not in body: ${seed.quote}`);
      const label = seed.label ?? null;
      return {
        claimId: computeBrainClaimId(documentId, seed.kind, label, seed.quote), kind: seed.kind, label,
        statement: seed.quote, quote: seed.quote, spanStart, spanEnd: spanStart + seed.quote.length, fields: {},
        confidence: "high" as const,
      };
    });
    await repository.applyDocumentExtraction(scope, {
      runId: run.runId, documentId, incarnation: document.incarnation, revision: document.revision, extractor,
      outcome: { status: "done", claims },
    });
  }
  await repository.closeExtractionRun(scope, {
    runId: run.runId, status: "succeeded", nextAction: "", errorCode: null,
    counts: { documentsProcessed: 0, documentsFailed: 0, claimsWritten: 0, claimsRemoved: 0, claimsRejected: 0, quotesRejected: 0 },
    usage: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
  });
}

/** A stable id for hand-written documents. */
export function impactDocumentId(seed: string): string {
  return createHash("sha256").update(JSON.stringify(["impact-test", seed])).digest("hex");
}

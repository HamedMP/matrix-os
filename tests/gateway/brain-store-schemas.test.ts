import { describe, expect, it } from "vitest";
import type { z } from "zod/v4";
import {
  BrainCreateSourceSchema,
  BrainDocumentContentSchema,
  BrainDocumentRefSchema,
  BrainListOptionsSchema,
  BrainRefMatchQuerySchema,
  BrainReviseDocumentSchema,
  BrainScopeKeySchema,
  BrainSearchSchema,
  BrainSyncBatchSchema,
  BrainUpdateSourceSchema,
  parseBrainInput,
} from "../../packages/gateway/src/brain/schemas.js";
import { BrainStoreError } from "../../packages/gateway/src/brain/types.js";

const DOCUMENT_ID = "a".repeat(64);
const SOURCE_ID = `src_${"b".repeat(32)}`;
const LONE_HIGH = "\ud800";
const LONE_LOW = "\udc00";

const content = {
  documentId: DOCUMENT_ID,
  title: "Launch plan",
  body: "We ship on Friday.",
  permalink: "https://example.com/doc",
  sourceUpdatedAt: "2026-10-01T10:00:00.000Z",
  provenance: "manual",
};

function expectInvalid(schema: z.ZodType, value: unknown): void {
  let caught: unknown;
  try {
    parseBrainInput(schema, value);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BrainStoreError);
  expect((caught as BrainStoreError).code).toBe("invalid");
}

/** Each case replaces one stored or compared free-text field with `text`. */
const freeTextCases: ReadonlyArray<[string, z.ZodType, (text: string) => unknown]> = [
  ["document title", BrainDocumentContentSchema, (text) => ({ ...content, title: `Plan ${text}` })],
  ["document body", BrainDocumentContentSchema, (text) => ({ ...content, body: `Ship ${text} Friday` })],
  ["revised body", BrainReviseDocumentSchema, (text) => ({ documentId: DOCUMENT_ID, expectedRevision: 1, body: text })],
  ["scope id", BrainScopeKeySchema, (text) => ({ scopeId: `scope_${text}`, ownerId: "owner_a" })],
  ["owner id", BrainScopeKeySchema, (text) => ({ scopeId: "scope_a", ownerId: `owner_${text}` })],
  ["source externalRef", BrainCreateSourceSchema, (text) => ({
    kind: "slack", externalRef: `T1/${text}`, label: "Slack",
  })],
  ["source label", BrainUpdateSourceSchema, (text) => ({ sourceId: SOURCE_ID, expectedRevision: 1, label: text })],
  ["ref value", BrainDocumentRefSchema, (text) => ({ kind: "path", value: `src/${text}.ts` })],
  ["sync cursor", BrainSyncBatchSchema, (text) => ({
    sourceId: SOURCE_ID, expectedCursor: null, nextCursor: `c_${text}`, upserts: [], deletions: [],
  })],
  ["list cursor", BrainListOptionsSchema, (text) => ({ cursor: `c_${text}` })],
  ["ref-match cursor", BrainRefMatchQuerySchema, (text) => ({
    kind: "path", value: "src", mode: "under", provenances: ["git_commit"], cursor: `c_${text}`,
  })],
  ["search query", BrainSearchSchema, (text) => ({ query: `launch ${text}` })],
];

describe("brain store input schemas", () => {
  it.each(freeTextCases)("accepts well-formed text in the %s", (_name, schema, build) => {
    expect(() => parseBrainInput(schema, build("café \u{1F600}"))).not.toThrow();
  });

  it.each(freeTextCases)("rejects a lone high surrogate in the %s", (_name, schema, build) => {
    expectInvalid(schema, build(LONE_HIGH));
  });

  it.each(freeTextCases)("rejects a lone low surrogate in the %s", (_name, schema, build) => {
    expectInvalid(schema, build(LONE_LOW));
  });

  it.each(freeTextCases)("rejects U+0000 in the %s", (_name, schema, build) => {
    expectInvalid(schema, build("\u0000"));
  });

  it("rejects a lone surrogate in a sync upsert body and ref", () => {
    const batch = (upsert: Record<string, unknown>) => ({
      sourceId: SOURCE_ID, expectedCursor: null, nextCursor: "c1", upserts: [upsert], deletions: [],
    });
    expect(() => parseBrainInput(BrainSyncBatchSchema, batch({ ...content, refs: [] }))).not.toThrow();
    expectInvalid(BrainSyncBatchSchema, batch({ ...content, body: `a${LONE_HIGH}`, refs: [] }));
    expectInvalid(BrainSyncBatchSchema, batch({ ...content, refs: [{ kind: "path", value: LONE_LOW }] }));
  });
});

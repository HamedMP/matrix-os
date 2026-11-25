/**
 * Files the document engine writes must be valid for other software: every
 * fixture goes through every kind of edit, tracked and direct, and through
 * accepting, rejecting and partly resolving the result, and each saved file
 * is held to the WordprocessingML rules of `./wml-rules.ts`.
 *
 * A fixture's own problems (text it already held in a form the rules flag)
 * are not the engine's and are left out.
 */

import { describe, expect, it } from "vitest";
import type { DocxDocument } from "../../../packages/office/src/index.js";
import { compareDocx, createDocx, createDocxFromMarkdown, openDocx } from "../../../packages/office/src/index.js";
import { loadFixture } from "./package.js";
import { AGENT, DIRECT, DOCX_FIXTURES, OWNER, isCommentStep, resolvePartially, runSteps } from "./scenarios.js";
import { wordProblems } from "./wml-rules.js";

const inherited = new Map<string, Promise<Set<string>>>();

/** The problems the unedited fixture has, in the two spellings an edit can give them. */
function fixtureProblems(name: string): Promise<Set<string>> {
  let known = inherited.get(name);
  if (known === undefined) {
    known = wordProblems(loadFixture(`${name}.docx`)).then((problems) => new Set(problems.map(problemKind)));
    inherited.set(name, known);
  }
  return known;
}

/** A problem without the text it quotes, so that an edited copy of a fixture's text still matches. */
function problemKind(problem: string): string {
  return problem.replace(/<w:delText>/g, "<w:t>").replace(/ "[^"]*"$/, "");
}

async function expectValid(doc: DocxDocument, fixture: string | null): Promise<Uint8Array> {
  const bytes = await doc.save();
  const known = fixture === null ? new Set<string>() : await fixtureProblems(fixture);
  expect((await wordProblems(bytes)).filter((problem) => !known.has(problemKind(problem)))).toEqual([]);
  return bytes;
}

async function edited(fixture: string, options = AGENT): Promise<DocxDocument> {
  const doc = await openDocx(loadFixture(`${fixture}.docx`));
  expect(runSteps(doc, options).length).toBeGreaterThan(20);
  return doc;
}

describe.each(DOCX_FIXTURES)("%s.docx stays valid", (fixture) => {
  it("with every kind of tracked edit", async () => {
    const doc = await edited(fixture);
    expect(doc.listRevisions().length).toBeGreaterThan(10);
    await expectValid(doc, fixture);
  });

  it("with every kind of direct edit", async () => {
    const doc = await edited(fixture, DIRECT);
    await expectValid(doc, fixture);
  });

  it("after accepting every tracked edit", async () => {
    const doc = await edited(fixture);
    doc.acceptRevisions("all");
    expect(doc.listRevisions()).toEqual([]);
    await expectValid(doc, fixture);
  });

  it("after rejecting every tracked edit", async () => {
    const before = (await openDocx(loadFixture(`${fixture}.docx`))).getPlainText({ view: "original" });
    const doc = await edited(fixture);
    doc.rejectRevisions("all");
    expect(doc.listRevisions()).toEqual([]);
    expect(doc.getPlainText()).toBe(before);
    await expectValid(doc, fixture);
  });

  it("after resolving the tracked edits one way and the other", async () => {
    const doc = await edited(fixture);
    resolvePartially(doc);
    await expectValid(doc, fixture);
  });

  it("when a second author edits on top, and after accepting and rejecting both", async () => {
    const first = await edited(fixture);
    const bytes = await first.save();
    for (const resolve of ["none", "accept", "reject"] as const) {
      const doc = await openDocx(bytes);
      runSteps(doc, OWNER, (step) => !isCommentStep(step));
      if (resolve === "accept") doc.acceptRevisions("all");
      if (resolve === "reject") doc.rejectRevisions("all");
      await expectValid(doc, fixture);
    }
  });

  it("when direct edits cut through pending changes", async () => {
    const first = await edited(fixture);
    const doc = await openDocx(await first.save());
    runSteps(doc, DIRECT, (step) => !isCommentStep(step));
    await expectValid(doc, fixture);
  });

  it("when compared with its directly edited copy, both ways, and resolved", async () => {
    const source = loadFixture(`${fixture}.docx`);
    const changed = await (await edited(fixture, DIRECT)).save();
    for (const [original, revised] of [
      [source, changed],
      [changed, source],
    ] as const) {
      const result = await compareDocx(original, revised, { author: "Compare", date: "2026-11-23T12:00:00Z" });
      const bytes = await expectValid(result, fixture);
      const accepted = await openDocx(bytes);
      accepted.acceptRevisions("all");
      await expectValid(accepted, fixture);
      const rejected = await openDocx(bytes);
      rejected.rejectRevisions("all");
      await expectValid(rejected, fixture);
    }
  });
});

describe("created documents stay valid", () => {
  const markdown = [
    "# Review",
    "",
    "Intro with **bold**, *italic*, ~~struck~~, `code` and a [link](https://example.com/a?b=1&c=2).",
    "",
    "1. First",
    "2. Second",
    "   - nested bullet",
    "",
    "> A quote",
    "",
    "```ts",
    'const x = 1 < 2 && "a";',
    "```",
    "",
    "| Name | Amount |",
    "| --- | ---: |",
    "| Alpha | 10 |",
    "",
    "Final paragraph.",
  ].join("\n");
  const makers: Array<[string, () => DocxDocument]> = [
    ["a blank document", () => createDocx()],
    [
      "a document from paragraphs",
      () =>
        createDocx({
          title: "Created & <titled>",
          author: "Rae Okafor",
          date: "2026-11-23T09:00:00Z",
          paragraphs: [{ text: "Title", style: { headingLevel: 1 } }, "Plain with a\ttab and a\nline break.", { text: "  padded  ", style: { alignment: "center" } }, ""],
        }),
    ],
    ["a document from Markdown", () => createDocxFromMarkdown(markdown, { title: "From Markdown" })],
    ["a document from Markdown with Windows line endings", () => createDocxFromMarkdown(markdown.replace(/\n/g, "\r\n"))],
  ];

  it.each(makers)("%s, as created and after edits", async (_label, make) => {
    await expectValid(make(), null);
    const tracked = make();
    runSteps(tracked, AGENT);
    const bytes = await expectValid(tracked, null);
    const accepted = await openDocx(bytes);
    accepted.acceptRevisions("all");
    await expectValid(accepted, null);
    const rejected = await openDocx(bytes);
    rejected.rejectRevisions("all");
    expect(rejected.getPlainText()).toBe(make().getPlainText());
    await expectValid(rejected, null);
    const direct = make();
    runSteps(direct, DIRECT);
    await expectValid(direct, null);
  });
});

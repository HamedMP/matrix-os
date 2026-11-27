# Interoperability tests

These tests hold the files the document engine writes to the rules other
software enforces, and hold what the engine reports to what is in the file.
They use only the engine's public API and its container and XML modules; no
Python and no second reader is needed to run them.

```bash
NODE_OPTIONS=--no-experimental-webstorage node node_modules/vitest/vitest.mjs run tests/office/interop
```

## Rule checkers

| File | What it checks on the raw XML of a saved file |
| --- | --- |
| `wml-order.ts` | WordprocessingML child order (`w:pPr`, `w:rPr`, `w:tcPr`, `w:tblPr`, `w:trPr`, `w:sectPr`, settings, styles, numbering), where revision elements may stand and what they may hold, deleted text in `w:delText`, `xml:space` on padded text, author and date on every revision. |
| `wml-rules.ts` | Unique revision ids, balanced and ordered bookmarks, comment ranges, move ranges and fields, one reference per comment, comment markers only in the main document, references to styles, numbering, notes and relationships that exist. |
| `sml-rules.ts` | SpreadsheetML element order (workbook, worksheet, styles), ascending rows and cells, cell types against values, shared string indexes and the stated count, style indexes in range, merged ranges, column ranges, frozen panes, tables against their header cells. |

`wordProblems(bytes)` and `sheetProblems(bytes)` return one line per problem.
A fixture's own oddities (the cached table of contents of `links-fields.docx`
holds a raw tab) are left out by the tests that inherit them.

## Scenarios

`scenarios.ts` and `sheet-scenarios.ts` are edit batches that work on any
document or workbook: every operation kind, and the edits that cut through
links, fields, notes, comment anchors, bookmarks, merged cells and tables.

## Tests

| File | Covers |
| --- | --- |
| `docx-conformance.test.ts` | Every `.docx` fixture and created document: tracked and direct edits, accept, reject, partial resolution, a second author, direct edits over pending ones, comparison both ways. |
| `xlsx-conformance.test.ts` | Every `.xlsx` fixture, created workbooks and CSV: values, formulas, structure, styles, sheets, proposals pending, accepted, rejected and partly resolved; each file reads back as saved. |
| `docx-anchors.test.ts` | Comment anchors, bookmarks and field characters outlive removed content. |
| `docx-double-revisions.test.ts` | A mark or row two authors changed, a move split by an edit, a tracked table before the last paragraph: the views are what resolving gives. |
| `docx-comment-stories.test.ts` | Comments are refused outside the body. |
| `xlsx-text.test.ts` | Carriage returns in cell text, and the count of the shared string table. |
| `xlsx-tables.test.ts` | Tables move with rows and columns, are not cut apart, and keep column names with header cells. |

The independent Python readers in `../tools/` check the same files from the
outside; these tests are the part of that check that runs everywhere.

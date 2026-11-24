# Independent office validation tools

Python tools that check Word and Excel files without the Matrix OS document engine, so
the engine's output can be cross-checked by a second implementation. They need
`python-docx`, `openpyxl` and `lxml`. In this workspace a ready virtualenv is at
`/tmp/claude-1001/-home-hamed-projects-matrix-os/0b00e3bb-eee3-4b7c-862a-007d54146889/scratchpad/pyval/bin/python`
(any Python with those packages works). The vitest suite never calls these tools.

```bash
PY=/tmp/claude-1001/-home-hamed-projects-matrix-os/0b00e3bb-eee3-4b7c-862a-007d54146889/scratchpad/pyval/bin/python

$PY tests/office/tools/validate_docx.py <file.docx> [--quiet]
$PY tests/office/tools/validate_xlsx.py <file.xlsx> [--quiet] [--max-formulas N]
$PY tests/office/tools/accept_all.py <file.docx>            # text after accepting all changes
$PY tests/office/tools/accept_all.py <file.docx> --reject   # text after rejecting all changes
$PY tests/office/tools/accept_all.py <file.docx> --json     # {"accept": ..., "reject": ...}
$PY tests/office/tools/selftest.py                          # tests the tools themselves
```

Exit codes: `0` valid, `1` invalid (the JSON `errors` list and a one-line `INVALID ...`
message on stderr give the reason), `2` usage error.

## What the validators check

Package checks (shared, `ooxml_package.py`):

- The file is a ZIP with at most 2000 entries, 50 MB per entry and 200 MB in total, no
  absolute or `..` entry names and no duplicate part names.
- Every XML part is well-formed. Parsing loads no DTD, expands no entities and uses no
  network; a part that declares a DTD is rejected.
- `[Content_Types].xml` gives every part a content type (by `Default` extension or
  `Override`), and every `Override` names a part that exists.
- Every `.rels` part belongs to an existing part, relationship ids are unique, and every
  internal relationship target exists.

Then each file is opened with a second reader (`python-docx` or `openpyxl`).

`validate_docx.py` also fails on revision elements without `w:author`, duplicate
revision ids within a part, and comment references without a comment. Its JSON summary
reports paragraph counts (body, all including tables, python-docx), tables, numbered
paragraphs, paragraph styles, hyperlinks, bookmarks, field instructions, footnote
references, character count; revisions by kind (`ins`, `del`, `moveFrom`, `moveTo`,
`rPrChange`, `pPrChange`, other property changes), by author and by author and kind,
found by scanning the document, headers, footers, footnotes, endnotes and comments;
comment count, replies and authors; footnote, header and footer counts.

`validate_xlsx.py` also fails on shared string indexes out of range and sheet name
mismatches between the XML and openpyxl. Its JSON summary reports sheet names and
states, shared string count, defined names, total cells and formulas, and per sheet:
dimension, cell count, every formula with its type (`normal`, `shared`, `array`), range
and cached value, formulas without a cached value, merged cells, frozen pane, column
widths, value types and size.

## Accept and reject rules (`accept_all.py`)

Accept all: remove `w:del` and `w:moveFrom` with their content, unwrap `w:ins` and
`w:moveTo`, remove rows marked deleted. Reject all: remove `w:ins` and `w:moveTo` with
their content, unwrap `w:del` and `w:moveFrom` (deleted text becomes visible), remove
rows marked inserted. Both drop property-change records and move range markers. A
paragraph whose mark is removed (deleted mark on accept, inserted mark on reject, a
moved-away mark) joins the next paragraph, in the body and inside a table cell. Text
inserted by one author and deleted by another disappears in both views.

Text output: one line per body paragraph in document order; a table row is one line with
cells separated by a tab (paragraphs inside a cell joined by a newline); `w:tab` is a
tab, `w:br`/`w:cr` a newline, `w:noBreakHyphen` U+2011, soft hyphens are dropped; field
instructions are hidden and cached field results shown. Headers, footers, footnotes and
comments are not included.

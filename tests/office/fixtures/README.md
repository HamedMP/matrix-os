# Office test fixtures

Small, deterministic Word, Excel and CSV files for the Matrix OS document engine tests
(spec: `specs/2710-office-mail-suite/spec.md`). Every file is under 200 KB, and the
people and companies in them are fictional.

## Regenerate

The fixtures are committed. To rebuild them, use a Python with `python-docx`, `openpyxl`
and `lxml` (the TypeScript suite never needs Python):

```bash
<venv>/bin/python tests/office/fixtures/generate.py          # write fixtures + expected/
<venv>/bin/python tests/office/fixtures/generate.py --check  # fail if anything differs
```

Output is byte-for-byte stable: ZIP timestamps, document properties and part order are
fixed. The generator validates every file with the independent tools in
`../tools/` before writing, and fails if one is invalid.

## Files

| File | What it exercises |
| --- | --- |
| `basic.docx` | Title, Heading 1/2, runs with bold, italic, underline and all three combined; custom paragraph style `Callout Note` and character style `Key Term`; centred paragraph; built-in `Quote` style. |
| `numbering.docx` | Multi-level numbered list `1.` / `1.1.` / `(a)` (numId 1), bullet list with a second level (numId 2), and a second numbered list that restarts at 1 through `w:lvlOverride/w:startOverride` (numId 3). 15 numbered paragraphs. |
| `table.docx` | `Table Grid` table with a horizontally merged title row (`w:gridSpan`), a vertically merged cell (`w:vMerge`), header cells using paragraph style `Table Label`, and a second styled paragraph inside a cell. |
| `comments.docx` | Three comments by two authors: comment 0 and 1 on separate ranges, comment 2 is a reply to comment 0 (`word/commentsExtended.xml`, `w15:paraIdParent`). Comment ranges and references in the body. |
| `footnotes-headers.docx` | Three footnotes (plus separator and continuation separator), a header, and a footer with a complex `PAGE` field and a simple `NUMPAGES` field. |
| `tracked.docx` | Raw tracked changes by **Alex Morgan** and **Priya Shah**: run insertions and deletions, a deletion nested inside another author's insertion, a fully deleted paragraph (deleted paragraph mark), a fully inserted paragraph, a paragraph move (`w:moveFrom`/`w:moveTo` with range markers), a bold formatting change (`w:rPrChange`), an alignment change (`w:pPrChange`) and an inserted table row (`w:trPr/w:ins`). 21 revision elements: ins 11, del 4, moveFrom 2, moveTo 2, rPrChange 1, pPrChange 1. |
| `links-fields.docx` | External hyperlink (relationship to `https://example.com/terms`), internal hyperlink to a bookmark, bookmarks `_Toc1001`, `_Toc1002`, `_Ref_Definitions`, a multi-paragraph `TOC` field with cached entries, `REF` and `PAGEREF` cross-reference fields, and a simple `DATE` field. |
| `contract.docx` | A three-page A4 services agreement: parties, background, a definitions clause with bold quoted defined terms using "means", 12 numbered clauses with typed numbers (`8.2`, `10.2(b)`), cross-references such as "clause 8.1" and "clause 10.2(b)", signature blocks and a schedule. Planted review issues: the defined term **Change Request** is never used, **Customer Data** (clause 10.3) is capitalised but never defined, and clause 12.5 refers to a clause 14.3 that does not exist. |
| `contract-v2.docx` | The same agreement with 12 edits listed in `expected/contract-edits.json`: date, term 24 to 36 months, notice 90 to 60 days, availability 99.5% to 99.9%, Charges £18,500 to £19,250, payment 30 to 45 days, new clause 7.4, liability cap 125% to 100%, insurance £2m/3 years to £5m/6 years, cure period 30 to 21 days, a deleted sentence in 11.1, and the "Service Levels" definition moved after "Services". No tracked changes: it is the input for document comparison. |
| `unicode.docx` | Hebrew and Arabic right-to-left paragraphs (`w:bidi`, `w:rtl`), emoji including a ZWJ sequence and a flag, non-breaking spaces, tabs, a soft line break, leading/trailing/double spaces (`xml:space="preserve"`), a word split across runs, precomposed versus combining accents, CJK, XML special characters, a non-breaking hyphen and a soft hyphen. |
| `basic.xlsx` | Sheet `Basics`: integers, negative, decimal, a 13-digit number, strings (repeated strings share one entry in `xl/sharedStrings.xml`), unicode, booleans, a date, a date-time, a numeric-looking text, a long string, a gap column, an isolated cell, and one inline string cell (`t="inlineStr"`). |
| `formulas.xlsx` | Sheets `Data` and `Calc`: `SUM`, `AVERAGE`, `IF`, `VLOOKUP`, `INDEX`/`MATCH`, `SUMPRODUCT`, cross-sheet references, relative (`C2*D2`) and absolute (`Calc!$B$6`, `$E$2:$E$6`) references, the defined name `TaxRate` (= `Calc!$B$6`), a boolean result, an `#N/A` error result, and an array formula `Calc!D2:D6` whose range holds cached values. Every formula has a cached value. |
| `formats.xlsx` | Currency (USD with red negatives, GBP, EUR), percent, ISO and long dates, time, zero-padded, thousands with red negatives, scientific, fraction and text formats; fonts (name, size, bold, italic, underline, colour), solid fills, thin/thick/double borders, wrap, rotation, indent and centring; column widths; a taller row; merged cells `A1:F1` and `E3:F5`; panes frozen at `B3`. |
| `multi-sheet.xlsx` | Five sheets: `Summary`, `Q1 Sales` and `Q2 Sales` (coloured tabs), `O'Brien Notes` (an apostrophe that must be quoted as `'O''Brien Notes'!A1`) and the hidden sheet `Hidden Lookup`; formulas across sheets including a multi-area `SUM` and a lookup into the hidden sheet. |
| `model.xlsx` | Small financial model. `Assumptions`: starting revenue £50,000, 3% monthly growth, 40% cost of sales, £18,000 monthly costs, 25% tax. `Projection`: 12 months (Jan to Dec 2027) of revenue, cost of sales, gross profit, costs, operating profit, tax and net income, all formulas with absolute references into `Assumptions`, totals in column N, frozen panes. `Summary`: **Total revenue is a typed-in 725,000**, which disagrees with `Projection!N4` (709,601.48); net income (157,320.67), margin and average costs are formulas. |
| `data.csv` | UTF-8, comma-separated, `\n` line endings: header, quoted field with a comma, doubled quotes, an embedded newline, a non-Latin name, empty fields, a thousands separator inside a quoted amount, and a negative amount. |

## Expected outputs (`expected/`)

Generated with the independent tools, so engine tests can compare without Python:

| File | Contents |
| --- | --- |
| `<file>.summary.json` | Output of `validate_docx.py` / `validate_xlsx.py`: paragraph, style, field, bookmark, comment, footnote and revision counts by kind and author; sheet names, cell counts, every formula with its cached value, merged cells, frozen panes and defined names. |
| `<file>.docx.txt` | Body text after accepting all tracked changes (the plain text for documents without changes), using the text rules in `../tools/README.md`. |
| `tracked.docx.reject.txt` | Body text after rejecting all tracked changes. |
| `contract-edits.json` | The edits that turn `contract.docx` into `contract-v2.docx`. |

`fixtures.test.ts` checks that every fixture exists, stays under 200 KB, unzips into the
right package shape and has its expected files.

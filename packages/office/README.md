# @matrix-os/office

The Matrix OS document engine: lossless OOXML packages, `.docx` documents with
native tracked revisions and comments, `.xlsx` workbooks with a formula engine
and a cell change journal, word-level redlines, and the bridge that lets the
agent propose edits the owner accepts or rejects.

Spec: `specs/2710-office-mail-suite/spec.md`.

## Rules for code in `src/`

- **Zero runtime dependencies.** `package.json` has no `dependencies`.
- **No Node built-ins.** No `node:*` import, no `Buffer`, no `process`. The
  same source runs in a browser and in Node 24. `tsconfig.json` enforces this
  with `types: []` and `lib: ["ES2022", "WebWorker"]`: only what exists in both
  environments type-checks (`Uint8Array`, `TextEncoder`, `TextDecoder`,
  `CompressionStream`, `DecompressionStream`, `Blob`, `Response`).
- **No clock and no ambient randomness in results.** Dates and authors are
  arguments (`date` is an ISO 8601 string from the caller).
- **Relative imports end in `.js`** (`import type { X } from "../api/docx.js"`),
  type imports use `import type`. The gateway (NodeNext), Vitest and the app
  builds (Vite) all resolve that form.
- **One error type.** Throw `OfficeError` from `src/errors.ts` with a code from
  `OFFICE_ERROR_CODES`. The code is safe to show a client; the message is for logs.
- Document text, cell text and XML are untrusted input. Keep every loop and
  buffer bounded (ZIP limits, XML depth, cell counts, diff tokens).
- Files stay under 500 lines.

## Layout and contracts

`src/api/*.ts` are type-only contract files. Each module implements its
contract exactly and exports the values named in the contract's `…Module`
interface from its own `index.ts`:

| Module  | Implementation index       | Contract (`src/api/`)                     | Module interface |
| ------- | -------------------------- | ----------------------------------------- | ---------------- |
| opc     | `src/opc/index.ts`         | `opc.ts`                                  | `OpcModule`      |
| xml     | `src/xml/index.ts`         | `xml.ts`                                  | `XmlModule`      |
| docx    | `src/docx/index.ts`        | `docx.ts`, `docx-model.ts`, `docx-ops.ts` | `DocxModule`     |
| xlsx    | `src/xlsx/index.ts`        | `xlsx.ts`, `xlsx-model.ts`                | `XlsxModule`     |
| formula | `src/xlsx/formula/index.ts`| `formula.ts`                              | `FormulaModule`  |
| redline | `src/redline/index.ts`     | `redline.ts`                              | `RedlineModule`  |
| agent   | `src/agent/index.ts`       | `agent.ts`                                | `AgentModule`    |

A function contract is a function type in PascalCase (`OpenDocx`); the
implementation exports the camelCase value (`openDocx`). To have the compiler
check an export against its contract, type it with the contract:

```ts
import type { DocxModule } from "../api/docx.js";
export const openDocx: DocxModule["openDocx"] = async (bytes, limits) => { /* … */ };
```

or assert the whole namespace in a test:

```ts
import type { DocxModule } from "../../packages/office/src/api/docx.js";
import * as docx from "../../packages/office/src/docx/index.js";
const contract: DocxModule = docx;
```

`src/index.ts` exports `OfficeError`, `isOfficeError`, `OFFICE_ERROR_CODES`,
every contract type, one namespace per module (`opc`, `xml`, `docx`, `xlsx`,
`formula`, `redline`, `agent`) and the main entry points by name:

| Area     | Named exports of `src/index.ts` |
| -------- | ------------------------------- |
| docx     | `openDocx`, `createDocx`, `createDocxFromMarkdown`, `compareDocx`, `compareDocxDetailed`, `toHtml`, `toMarkdown`, `toPlainText` |
| xlsx     | `openXlsx`, `createXlsx`, `parseCsv`, `toCsv`, `formatValue`, `listJournalChanges`, `getJournalWarnings`, `columnLabel`, `columnIndex`, `parseA1`, `formatA1`, `parseA1Range`, `formatA1Range`, `parseSheetRange`, `MAX_ROWS`, `MAX_COLS` |
| formula  | `parseFormula`, `serializeFormula`, `evaluate`, `createFunctionRegistry` |
| redline  | `diffWords`, `diffSequences`, `createRedline`, `loadRedline` |
| agent    | `describeDocx`, `describeSheet`, `parseAgentEdits`, `agentEditInstructions`, `toDocxOps`, `toSheetEdits`, `applySheetEdits` |

Namespaces keep short helper names such as the XML module's `find` and
`remove` out of the root, and hold what a module adds to its contract
(`redline.diffParagraphs`, `xlsx.serialToIso`, `formula.DependencyGraph`).
A module can always be imported from its own index.

How the modules fit together:

- `docx` builds on `opc` and `xml`. Document comparison uses `redline` for
  the paragraph alignment and the word-level diff.
- `xlsx` builds on `opc` and `xml`. A workbook calculates with the formula
  engine in `src/xlsx/formula/` and its whole function library (`TEXT` is
  rendered by the workbook's number formats), keeps array formulas filled,
  and records proposed changes in the journal in `src/xlsx/journal/`.
- `agent` uses only the public handles of `docx` and `xlsx`.

Conventions shared by all contracts:

- Spreadsheet rows and columns are zero-based (`A1` is row 0, column 0).
- Text offsets count UTF-16 code units. `.docx` positions address the markup
  text of a paragraph (pending insertions and deletions both included).
- Lengths are points, colours are `#rrggbb` in lower case.
- View models and results are plain JSON-safe data.

## Using the engine

From a workspace package (the gateway depends on `@matrix-os/office`):

```ts
import { isOfficeError, type DocxView } from "@matrix-os/office";
import { openDocx } from "@matrix-os/office/docx";
import { openXlsx } from "@matrix-os/office/xlsx";
```

Subpaths: `./errors`, `./opc`, `./xml`, `./docx`, `./xlsx`, `./formula`,
`./redline`, `./agent`.

From a test, by relative path: `../../packages/office/src/docx/index.js`.

From a default app under `home/apps/**`, by relative path into the mirror
(from `home/apps/<app>/src/`; one module index, or everything from the root):

```ts
import { describeDocx, openDocx, openXlsx, parseAgentEdits, toDocxOps } from "../../_shared/office-engine/index";
import type { DocxView, Revision } from "../../_shared/office-engine/index";
import { createRedline } from "../../_shared/office-engine/redline/index";
```

## The agent flow

```ts
const document = await openDocx(bytes);
const description = describeDocx(document, { maxChars: 24_000 });   // text for the prompt, with block ids
const parsed = parseAgentEdits(answer, "docx");                      // strict validation, never throws
if (parsed.ok && parsed.envelope.kind === "docx") {
  const plan = toDocxOps(document, parsed.envelope.edits);           // plan.rejected lists what did not resolve
  document.applyOps(plan.ops, { track: true, author, date });        // native tracked revisions
}
document.listRevisions();                                            // the owner accepts or rejects each
document.acceptRevisions([id]); document.rejectRevisions([id]);
const saved = await document.save();
```

For a workbook: `describeSheet`, `parseAgentEdits(answer, "sheet")`,
`toSheetEdits`, then `applySheetEdits(workbook, plan.edits, { author, date, label })`
records the edits as one proposal; `workbook.listChanges()`,
`acceptChanges` and `rejectChanges` resolve them.

## The mirror

Default apps are isolated pnpm projects that are rebuilt on the owner's
machine, where this package does not exist. `scripts/sync-office-engine.mjs`
copies `packages/office/src/**` byte for byte to
`home/apps/_shared/office-engine/`. The copy is generated and git-ignored:
never edit or commit it.

It is regenerated (up-to-date files are skipped) by everything that needs it:

| Path | What runs the sync |
| --- | --- |
| Tests | vitest global setup `tests/helpers/office-engine-global-setup.ts` |
| Dev | `bun run dev`, `dev:gateway`, `dev:mobile-shell`, `dev:source` |
| One app | `pnpm build` / `pnpm dev` in an office app run `home/apps/_shared/ensure-office-engine.mjs` |
| All apps | `scripts/build-default-apps.mjs`, before building any app |
| Docker image, docker dev, host bundle | `scripts/build-default-apps.mjs` (and the docker dev entrypoint before seeding a home) |
| Owner's computer | Nothing: the copy ships in the host bundle's `home/` and template manifest; `ensure-office-engine.mjs` only checks it is there |

```bash
node scripts/sync-office-engine.mjs          # regenerate by hand
node scripts/sync-office-engine.mjs --check  # exit 1 when the mirror is stale
```

`tests/office/engine-mirror.test.ts` checks the generator and each of these
paths.

## Checks

```bash
node_modules/.bin/tsc --noEmit -p packages/office/tsconfig.json
NODE_OPTIONS=--no-experimental-webstorage node node_modules/vitest/vitest.mjs run tests/office
```

`tests/office/interop/` holds every file the engine writes to the rules other
software enforces (element order, balanced anchors, unique ids, counts,
tables against their cells); see its README.

`tests/office/e2e/` runs the acceptance flows of the spec through the public
API only. With `OFFICE_E2E_OUT=<directory>` those tests also keep every file
they produce, for checking with the independent readers in `tests/office/tools/`.

The package is also part of `bun run typecheck` (`scripts/typecheck.mjs`).

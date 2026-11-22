/**
 * `@matrix-os/office`: lossless OOXML documents, tracked changes, workbooks
 * and formulas in pure TypeScript, for the browser and for Node.
 *
 * This file exports the error type and every contract type. The
 * implementations are separate modules, imported by path:
 *
 * | Module  | Path                         | Contract             |
 * | ------- | ---------------------------- | -------------------- |
 * | opc     | `./opc/index.js`             | `OpcModule`          |
 * | xml     | `./xml/index.js`             | `XmlModule`          |
 * | docx    | `./docx/index.js`            | `DocxModule`         |
 * | xlsx    | `./xlsx/index.js`            | `XlsxModule`         |
 * | formula | `./xlsx/formula/index.js`    | `FormulaModule`      |
 * | redline | `./redline/index.js`         | `RedlineModule`      |
 * | agent   | `./agent/index.js`           | `AgentModule`        |
 *
 * Inside the workspace they are also reachable as `@matrix-os/office/docx`
 * and so on (see `package.json`). Default apps import the mirrored copy under
 * `home/apps/_shared/office-engine/` by relative path.
 */

export { OFFICE_ERROR_CODES, OfficeError, isOfficeError } from "./errors.js";
export type { OfficeErrorCode, OfficeErrorDetails, OfficeErrorOptions } from "./errors.js";

export type * from "./api/opc.js";
export type * from "./api/xml.js";
export type * from "./api/docx.js";
export type * from "./api/formula.js";
export type * from "./api/xlsx.js";
export type * from "./api/redline.js";
export type * from "./api/agent.js";

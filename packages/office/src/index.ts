/**
 * `@matrix-os/office`: lossless OOXML documents, tracked changes, workbooks
 * and formulas in pure TypeScript, for the browser and for Node.
 *
 * This file exports the error type, every contract type and each implementation
 * module as a namespace (`opc.openPackage`, `xml.parseXml`).
 * A module can also be imported on its own by path:
 *
 * | Module  | Path                         | Contract             |
 * | ------- | ---------------------------- | -------------------- |
 * | opc     | `./opc/index.js`             | `OpcModule`          |
 * | xml     | `./xml/index.js`             | `XmlModule`          |
 *
 * Inside the workspace they are also reachable as `@matrix-os/office/opc`
 * and so on (see `package.json`).
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

// Implementations, one namespace per module. Namespaces keep short helper
// names (the XML module's `find`, `remove`) out of the root.
export * as opc from "./opc/index.js";
export * as xml from "./xml/index.js";

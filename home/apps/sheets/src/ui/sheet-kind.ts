import { extensionOf } from "../../../_shared/office-ui";

/** A grid for workbooks; text tables carry their extension. */
export function sheetKind(name: string): { kind: "workbook" | "table"; tag?: string } {
  const extension = extensionOf(name);
  return extension === ".csv" || extension === ".tsv" ? { kind: "table", tag: extension.slice(1) } : { kind: "workbook" };
}

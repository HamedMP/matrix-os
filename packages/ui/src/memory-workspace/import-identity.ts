import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod/v4";
import {
  MemoryImportRequestSchema,
  MemorySourceInputSchema,
} from "@matrix-os/contracts";
import type { MemoryImportSource } from "./model.js";
const fingerprint = (value: unknown) =>
  bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
const exportEnvelope = z
  .object({
    records: z.array(z.unknown()).max(100),
    warnings: z.array(z.string().max(500)).max(20).default([]),
  })
  .strict();
/** Replays the same selected batch within one explicit import intent. */
export function memoryImportRequestId(
  sources: MemoryImportSource[],
  intentId: string,
): string {
  return `import:${fingerprint([intentId, sources])}`;
}
export function parseMemoryImportBatch(
  name: string,
  text: string,
): { records: MemoryImportSource[]; warnings: string[] } {
  if (new TextEncoder().encode(text).length > 1_000_000)
    throw new Error("import_too_large");
  if (name.toLowerCase().endsWith(".json")) {
    const raw: unknown = JSON.parse(text);
    const batch = Array.isArray(raw)
      ? { records: raw, warnings: [] }
      : exportEnvelope.parse(raw);
    return {
      records: MemoryImportRequestSchema.parse({
        clientRequestId: "export-preview",
        sources: batch.records,
      }).sources,
      warnings: batch.warnings,
    };
  }
  if (!/\.(md|txt)$/i.test(name)) throw new Error("unsupported_import");
  return {
    records: [
      MemorySourceInputSchema.parse({
        externalId: `file:${fingerprint([name, text])}`,
        title: name.replace(/\.(md|txt)$/i, ""),
        content: text,
        kind: /\.md$/i.test(name) ? "note" : "document",
        collection: "Imported",
      }),
    ],
    warnings: [],
  };
}
export function parseMemoryImport(
  name: string,
  text: string,
): MemoryImportSource[] {
  return parseMemoryImportBatch(name, text).records;
}

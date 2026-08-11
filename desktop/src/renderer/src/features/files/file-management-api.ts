import { z } from "zod/v4";
import { AppError } from "../../../../shared/app-error";
import type { ApiClient } from "../../lib/api";
import {
  MAX_BROWSER_ENTRIES,
  type BrowserEntry,
  parseBrowserEntryCapabilities,
} from "./browser-entries";
import {
  FileEntryNameSchema,
  FileMutationNameSchema,
  OwnerDirectoryPathSchema,
  OwnerRelativePathSchema,
  RendererFileEntryCapabilitiesSchema,
} from "./file-management-contracts";

export const FILE_MUTATION_TIMEOUT_MS = 60_000;

const SMALL_STRING_MAX = 512;
const ResponseDirectorySchema = z.union([OwnerDirectoryPathSchema, z.literal(".")]).transform(
  (value) => value === "." ? "" : value,
);
const RequestIdSchema = z.uuid();

const ListingEntrySchema = z.object({
  name: FileEntryNameSchema,
  type: z.enum(["file", "directory"]),
  size: z.number().finite().nonnegative().optional(),
  modified: z.string().min(1).max(128).optional(),
  created: z.string().min(1).max(128).optional(),
  children: z.number().int().nonnegative().optional(),
  changedCount: z.number().int().nonnegative().optional(),
  gitStatus: z.string().max(64).nullable().optional(),
  mime: z.string().max(256).optional(),
  capabilities: z.unknown().optional(),
}).strict();
const ListingSchema = z.object({
  path: OwnerDirectoryPathSchema,
  entries: z.array(ListingEntrySchema).max(MAX_BROWSER_ENTRIES),
}).strict();

const MutationResultSchema = z.object({
  ok: z.literal(true),
  path: OwnerRelativePathSchema,
  resultCode: z.enum(["created", "renamed"]),
  capabilities: RendererFileEntryCapabilitiesSchema,
}).strict();
const InvalidCodeSchema = z.enum(["source_missing", "protected", "invalid_destination"]);
const PreflightSchema = z.object({
  sources: z.array(OwnerRelativePathSchema).min(1).max(100),
  destinationDirectory: OwnerRelativePathSchema,
  conflicts: z.array(z.object({ source: OwnerRelativePathSchema, destination: OwnerRelativePathSchema }).strict()).max(100),
  invalid: z.array(z.object({ source: OwnerRelativePathSchema, code: InvalidCodeSchema }).strict()).max(100),
  preflightFingerprint: z.string().min(1).max(SMALL_STRING_MAX),
}).strict();
const MoveResultCodeSchema = z.enum([
  "moved", "skipped", "source_missing", "destination_conflict", "protected", "invalid_destination", "failed",
]);
const ExecuteSchema = z.object({
  results: z.array(z.object({
    source: OwnerRelativePathSchema,
    destination: OwnerRelativePathSchema.optional(),
    code: MoveResultCodeSchema,
  }).strict()).max(100),
  affectedDirectories: z.array(ResponseDirectorySchema).max(100),
}).strict();
const TrashSchema = z.object({
  results: z.array(z.object({
    source: OwnerRelativePathSchema,
    code: z.enum(["trashed", "source_missing", "protected", "invalid_destination", "failed"]),
  }).strict()).max(100),
  sourceDirectory: ResponseDirectorySchema,
}).strict();

const SourcesSchema = z.array(OwnerRelativePathSchema).min(1).max(100).refine(
  (sources) => new Set(sources).size === sources.length,
).refine((sources) => sources.every((source) => parentDirectory(source) === parentDirectory(sources[0]!)));
const ConflictChoicesSchema = z.array(z.object({
  source: OwnerRelativePathSchema,
  resolution: z.enum(["keep-both", "skip"]),
}).strict()).max(100);

export type FileMutationResult = z.infer<typeof MutationResultSchema>;
export type FileMovePreflight = z.infer<typeof PreflightSchema>;
export type FileMoveExecution = z.infer<typeof ExecuteSchema>;
export type FileTrashExecution = z.infer<typeof TrashSchema>;
export type FileConflictChoice = z.infer<typeof ConflictChoicesSchema>[number];

export interface FileManagementApi {
  list(directory: string): Promise<{ path: string; entries: BrowserEntry[] }>;
  create(input: { requestId: string; parentDirectory: string; name: string; kind: "file" | "directory" }): Promise<FileMutationResult>;
  rename(input: { requestId: string; path: string; name: string }): Promise<FileMutationResult>;
  preflightMove(input: { requestId: string; sources: string[]; destinationDirectory: string }): Promise<FileMovePreflight>;
  executeMove(input: {
    requestId: string;
    sources: string[];
    destinationDirectory: string;
    preflightFingerprint: string;
    conflictChoices?: FileConflictChoice[];
  }): Promise<FileMoveExecution>;
  trash(input: { requestId: string; sources: string[] }): Promise<FileTrashExecution>;
}

export function createFileManagementApi(client: ApiClient): FileManagementApi {
  return {
    async list(directory) {
      const normalized = parseInput(OwnerDirectoryPathSchema, directory);
      const response = parseResponse(ListingSchema, await client.get(
        `/api/files/list?path=${encodeURIComponent(normalized)}`,
      ));
      if (response.path !== normalized) throw new AppError("server");
      return {
        path: response.path,
        entries: response.entries.map((entry) => toBrowserEntry(entry)),
      };
    },
    async create(input) {
      const body = parseInput(z.object({
        requestId: RequestIdSchema, parentDirectory: OwnerDirectoryPathSchema, name: FileMutationNameSchema,
        kind: z.enum(["file", "directory"]),
      }).strict(), input);
      const response = parseResponse(MutationResultSchema, await client.post(
        "/api/files/create", body, { timeoutMs: FILE_MUTATION_TIMEOUT_MS },
      ));
      if (response.path !== joinPath(body.parentDirectory, body.name) || response.resultCode !== "created") throw new AppError("server");
      return response;
    },
    async rename(input) {
      const body = parseInput(z.object({
        requestId: RequestIdSchema, path: OwnerRelativePathSchema, name: FileMutationNameSchema,
      }).strict(), input);
      const response = parseResponse(MutationResultSchema, await client.post(
        "/api/files/rename", body, { timeoutMs: FILE_MUTATION_TIMEOUT_MS },
      ));
      if (response.path !== joinPath(parentDirectory(body.path), body.name) || response.resultCode !== "renamed") throw new AppError("server");
      return response;
    },
    async preflightMove(input) {
      const body = parseInput(z.object({
        requestId: RequestIdSchema, sources: SourcesSchema, destinationDirectory: OwnerRelativePathSchema,
      }).strict(), input);
      const response = parseResponse(PreflightSchema, await client.post(
        "/api/files/batch/move", { ...body, phase: "preflight" }, { timeoutMs: FILE_MUTATION_TIMEOUT_MS },
      ));
      const conflictSources = response.conflicts.map((item) => item.source);
      const invalidSources = response.invalid.map((item) => item.source);
      if (!sameOrderedPaths(response.sources, body.sources) || response.destinationDirectory !== body.destinationDirectory
        || !orderedSubset(conflictSources, body.sources) || !orderedSubset(invalidSources, body.sources)
        || conflictSources.some((source) => invalidSources.includes(source))
        || response.conflicts.some((item) => item.destination !== joinPath(body.destinationDirectory, basename(item.source)))) {
        throw new AppError("server");
      }
      return response;
    },
    async executeMove(input) {
      const body = parseInput(z.object({
        requestId: RequestIdSchema,
        sources: SourcesSchema,
        destinationDirectory: OwnerRelativePathSchema,
        preflightFingerprint: z.string().min(1).max(SMALL_STRING_MAX),
        conflictChoices: ConflictChoicesSchema.optional(),
      }).strict(), input);
      const { sources, destinationDirectory, ...wireBody } = body;
      const response = parseResponse(ExecuteSchema, await client.post(
        "/api/files/batch/move", { ...wireBody, phase: "execute" }, { timeoutMs: FILE_MUTATION_TIMEOUT_MS },
      ));
      const expectedDirectories = firstSeen([...sources.map(parentDirectory), destinationDirectory]);
      if (!sameOrderedPaths(response.results.map((item) => item.source), sources)
        || !sameOrderedPaths(response.affectedDirectories, expectedDirectories)
        || response.results.some((item) => item.code === "moved"
          ? item.destination === undefined || parentDirectory(item.destination) !== destinationDirectory
          : item.destination !== undefined)) {
        throw new AppError("server");
      }
      return response;
    },
    async trash(input) {
      const body = parseInput(z.object({ requestId: RequestIdSchema, sources: SourcesSchema }).strict(), input);
      const response = parseResponse(TrashSchema, await client.post(
        "/api/files/batch/trash", body, { timeoutMs: FILE_MUTATION_TIMEOUT_MS },
      ));
      if (!sameOrderedPaths(response.results.map((item) => item.source), body.sources)
        || response.sourceDirectory !== parentDirectory(body.sources[0]!)) throw new AppError("server");
      return response;
    },
  };
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError("server");
  return parsed.data;
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError("server");
  return parsed.data;
}

function toBrowserEntry(entry: z.infer<typeof ListingEntrySchema>): BrowserEntry {
  return {
    name: entry.name,
    type: entry.type,
    capabilities: parseBrowserEntryCapabilities(entry.capabilities),
    ...(entry.size !== undefined ? { sizeBytes: entry.size } : {}),
    ...(entry.modified !== undefined ? { modifiedAt: entry.modified } : {}),
    ...(entry.children !== undefined ? { children: entry.children } : {}),
  };
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}
function basename(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }
function joinPath(parent: string, name: string): string { return parent ? `${parent}/${name}` : name; }
function sameOrderedPaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}
function orderedSubset(candidate: readonly string[], source: readonly string[]): boolean {
  let previous = -1;
  for (const path of candidate) {
    const index = source.indexOf(path);
    if (index <= previous) return false;
    previous = index;
  }
  return true;
}
function firstSeen(values: readonly string[]): string[] { return [...new Set(values)]; }

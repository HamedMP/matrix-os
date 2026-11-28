import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { MatrixOpenAiConnectSchema, MatrixOpenAiDisconnectSchema, MatrixOpenAiSourceStateSchema,
  type MatrixOpenAiConnect, type MatrixOpenAiDisconnect, type MatrixOpenAiSourceState } from "@matrix-os/contracts";
import { readBoundedJsonFileWithIdentity } from "../bounded-json-file.js";
import { assertOwnerOpenAiKeyParents, createOwnerOpenAiKeySaver, readOwnerOpenAiKey } from "./owner-openai-key.js";
import { NativeProviderWriteNotStartedError, type NativeProviderProfileGuard } from "./native-provider-profile-guard.js";
import { createNativeProviderWriterLease } from "./native-provider-writer-lease.js";
import { writeProviderJsonAtomic } from "./provider-settings-persistence.js";

const MAX_RECEIPTS = 64;
const Receipt = z.object({ key: z.string().min(1).max(128), payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  appliedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();
const Document = z.object({ state: MatrixOpenAiSourceStateSchema, receipts: z.array(Receipt).max(MAX_RECEIPTS) }).strict()
  .refine(document => new Set(document.receipts.map(receipt => receipt.key)).size === document.receipts.length
    && document.receipts.every(receipt => receipt.appliedRevision <= document.state.revision));
type SourceDocument = z.infer<typeof Document>;
export interface MatrixOpenAiSourceMutationResult { state: MatrixOpenAiSourceState; appliedRevision: number; replayed: boolean }
/** Every classified rejection proves no publication began; the shared guard may release safely. */
export class MatrixOpenAiSourceError extends NativeProviderWriteNotStartedError {
  override readonly code: "conflict" | "rejected" | "unavailable";
  constructor(code: "conflict" | "rejected" | "unavailable") { super(); this.code = code; this.message = code; }
}
/** Publication may have begun; unlike a classified rejection this must retain the durable fence. */
export class MatrixOpenAiPublicationUncertainError extends Error {
  constructor(cause?: unknown) { super("Matrix source publication uncertain", { cause }); this.name = "MatrixOpenAiPublicationUncertainError"; }
}
const missing = (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
const initial = (): SourceDocument => ({ state: { version: 1, revision: 0, enabled: false, credentialGeneration: null }, receipts: [] });
const pathFor = (home: string) => join(resolve(home), "system/ai-providers/matrix-openai-source.json");

async function readDocument(home: string): Promise<SourceDocument> {
  try {
    await assertOwnerOpenAiKeyParents(home, false);
    const metadata = await lstat(pathFor(home));
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) throw new MatrixOpenAiSourceError("unavailable");
    const document = await readBoundedJsonFileWithIdentity(pathFor(home), 65_536);
    if (!document || document.identity.dev !== metadata.dev || document.identity.ino !== metadata.ino
      || document.identity.size !== metadata.size || document.identity.mtimeMs !== metadata.mtimeMs) throw new MatrixOpenAiSourceError("unavailable");
    return Document.parse(document.value);
  } catch (error) {
    if (missing(error)) return initial();
    if (error instanceof MatrixOpenAiSourceError) throw error;
    console.warn("[matrix-connection] Source read unavailable:", error instanceof Error ? error.name : "UnknownError");
    throw new MatrixOpenAiSourceError("unavailable");
  }
}

/** Legacy presence is not an explicit Matrix generation; unsafe custody is never absence. */
export async function readMatrixOpenAiCredentialGeneration(home: string): Promise<string | null> {
  const key = await readOwnerOpenAiKey(home);
  if (key.state === "invalid" || key.state === "unavailable") throw new MatrixOpenAiSourceError("unavailable");
  return key.credentialGeneration ?? null;
}

function fingerprint(kind: "connect" | "disconnect", request: MatrixOpenAiConnect | MatrixOpenAiDisconnect) {
  return createHash("sha256").update(JSON.stringify([kind, request.expectedRevision, request.expectedCredentialGeneration,
    "apiKey" in request ? request.apiKey : null])).digest("hex");
}
/** Persistence only: trusted callers must verify the fixed provider before commitConnection.
 * This coordinator owns the shared durable guard; do not wrap it in another guarded saver.
 * Key publication invokes the final atomic metadata write inside the existing rollback transaction.
 */
export function createMatrixOpenAiSourceStore(options: { homePath: string; profileGuard: NativeProviderProfileGuard }) {
  if (!options.homePath || !options.profileGuard?.run) throw new Error("Matrix source admission dependencies required");
  const saver = createOwnerOpenAiKeySaver(options);
  const writers = createNativeProviderWriterLease(options.homePath);
  const assertAvailable = () => writers.assertAvailable("codex");
  const mutate = async (kind: "connect" | "disconnect", input: MatrixOpenAiConnect | MatrixOpenAiDisconnect): Promise<MatrixOpenAiSourceMutationResult> => {
    const parsed = kind === "connect" ? MatrixOpenAiConnectSchema.safeParse(input) : MatrixOpenAiDisconnectSchema.safeParse(input);
    if (!parsed.success) throw new MatrixOpenAiSourceError("rejected");
    const request = parsed.data;
    // Private bounded retry metadata only; never a public credential identity or status field.
    const payloadHash = fingerprint(kind, request);
    let disconnectPublished = false;
    const mutation = options.profileGuard.run("codex", { kind: "write" }, async () => {
      const document = await readDocument(options.homePath);
      const receipt = document.receipts.find(candidate => candidate.key === request.idempotencyKey);
      if (receipt) {
        if (receipt.payloadHash !== payloadHash) throw new MatrixOpenAiSourceError("conflict");
        return { state: document.state, appliedRevision: receipt.appliedRevision, replayed: true };
      }
      if (document.state.revision !== request.expectedRevision || document.state.revision === Number.MAX_SAFE_INTEGER
        || await readMatrixOpenAiCredentialGeneration(options.homePath) !== request.expectedCredentialGeneration) throw new MatrixOpenAiSourceError("conflict");
      const publish = async (credentialGeneration: string | null) => {
        const state = MatrixOpenAiSourceStateSchema.parse({ ...document.state, enabled: kind === "connect", revision: document.state.revision + 1, credentialGeneration });
        const next = { state, receipts: [...document.receipts, { key: request.idempotencyKey, payloadHash, appliedRevision: state.revision }].slice(-MAX_RECEIPTS) };
        await assertOwnerOpenAiKeyParents(options.homePath, true);
        await writeProviderJsonAtomic(pathFor(options.homePath), Document.parse(next));
        return state;
      };
      let state: MatrixOpenAiSourceState | undefined;
      if (kind === "connect") {
        if (!("apiKey" in request) || typeof request.apiKey !== "string") throw new MatrixOpenAiSourceError("rejected");
        await saver.connect(request.apiKey, async generation => { state = await publish(generation); });
      } else {
        try { state = await publish(document.state.credentialGeneration); disconnectPublished = true; }
        catch (error) {
          // The atomic writer ends at rename. Independently prove prior metadata survived
          // before classifying failure as no publication; read failure or changed bytes retain fencing.
          let current: SourceDocument;
          try { current = await readDocument(options.homePath); }
          catch (proofError) {
            console.warn("[matrix-connection] Source rollback proof unavailable:", proofError instanceof Error ? proofError.name : "UnknownError");
            throw new MatrixOpenAiPublicationUncertainError(error);
          }
          if (JSON.stringify(current) !== JSON.stringify(document)) throw new MatrixOpenAiPublicationUncertainError();
          console.warn("[matrix-connection] Source publication not started:", error instanceof Error ? error.name : "UnknownError");
          throw new MatrixOpenAiSourceError("unavailable");
        }
      }
      if (!state) throw new MatrixOpenAiPublicationUncertainError();
      return { state, appliedRevision: state.revision, replayed: false };
    });
    try { return await mutation; }
    catch (error) {
      // A successful new publication may still fail while releasing its durable lease.
      // Consumers must withdraw even then; preflight/replay failures did not publish.
      if (disconnectPublished && !(error instanceof MatrixOpenAiPublicationUncertainError)) throw new MatrixOpenAiPublicationUncertainError(error);
      throw error;
    }
  };
  return {
    async replayConnection(input: MatrixOpenAiConnect): Promise<MatrixOpenAiSourceMutationResult | null> {
      const parsed = MatrixOpenAiConnectSchema.safeParse(input);
      if (!parsed.success) throw new MatrixOpenAiSourceError("rejected");
      return options.profileGuard.run("codex", { kind: "write" }, async () => {
        const document = await readDocument(options.homePath);
        const receipt = document.receipts.find(candidate => candidate.key === parsed.data.idempotencyKey);
        if (!receipt) return null;
        if (receipt.payloadHash !== fingerprint("connect", parsed.data)) throw new MatrixOpenAiSourceError("conflict");
        return { state: document.state, appliedRevision: receipt.appliedRevision, replayed: true };
      });
    },
    assertAvailable,
    async read(): Promise<MatrixOpenAiSourceState> {
      // Prior enabled metadata/key bytes are not authority while a writer is unresolved.
      // Check again after reading so a writer admitted during the read also fences it.
      await assertAvailable();
      const document = await readDocument(options.homePath);
      await assertAvailable();
      return document.state;
    },
    commitConnection: (request: MatrixOpenAiConnect) => mutate("connect", request),
    disconnect: (request: MatrixOpenAiDisconnect) => mutate("disconnect", request),
  };
}

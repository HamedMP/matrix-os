import { z } from 'zod/v4';
import { readSharedFileSnapshot, type PostgresWorkspaceRepository } from './data/repository.js';
import type { WorkspaceFiles } from './data/files.js';
import type { RuntimeJob, RuntimeLease } from './runtime/contracts.js';
import type { RuntimeOutput } from './runtime/native-driver.js';
import { isRuntimePrivatePath } from '../runtime/paths.mjs';

const safePath = z.string().min(1).max(512).refine(path => !path.startsWith('/') && !isRuntimePrivatePath(path) && !/[\\\u0000-\u001f]/.test(path)
  && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'));
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const job = z.discriminatedUnion('type', [
  z.object({ownerId:identity,jobId:identity,type:z.literal('wake')}).strict(),
  z.object({ownerId:identity,jobId:identity,type:z.literal('chat'),chatId:z.string().regex(/^chat_[A-Za-z0-9_-]{1,128}$/),message:z.string().min(1).max(16000)}).strict(),
]);
export function parseQueuedJob(value: unknown): RuntimeJob { return job.parse(value); }

export async function hydrateWorkspace(repository: PostgresWorkspaceRepository, files: WorkspaceFiles, ownerId: string,
  revisions: Map<string, number> = new Map()): Promise<RuntimeOutput['files']> {
  revisions.clear();
  const stored = (await repository.listFiles(ownerId, '', 100)).filter(file => !isRuntimePrivatePath(file.path));
  if (stored.length >= 100) throw new Error('Workspace projection exceeds spike limit');
  const result: RuntimeOutput['files'] = [];
  let bytes = 0;
  for (const file of stored) {
    safePath.parse(file.path);
    const snapshot = await readSharedFileSnapshot(repository, key => files.read(key), ownerId, file);
    const { content } = snapshot;
    bytes += new TextEncoder().encode(content).byteLength;
    if (bytes > 900_000) throw new Error('Workspace projection exceeds spike limit');
    revisions.set(file.path, snapshot.file.revision);
    result.push({path:file.path, content});
  }
  return result;
}

/** Stage immutable objects; only a current lease can publish all revisions. */
export async function publishRuntimeOutput(repository: PostgresWorkspaceRepository, files: WorkspaceFiles,
  lease: RuntimeLease, output: RuntimeOutput, revisions: Map<string, number> = new Map()): Promise<void> {
  if (output.files.length > 20 || typeof output.text !== 'string' || output.text.length > 32000) throw new Error('Invalid runtime output');
  const staged: {path:string;objectKey:string;bytes:number;baseRevision:number}[] = [];
  const superseded: string[] = [];
  let publicationStarted = false;
  try {
    for (const file of output.files) {
      safePath.parse(file.path);
      const previous = await repository.file(lease.ownerId, file.path);
      const objectKey = await files.write(lease.ownerId, file.content);
      staged.push({path:file.path,objectKey,bytes:new TextEncoder().encode(file.content).byteLength,baseRevision:revisions.get(file.path) ?? 0});
      if (previous) superseded.push(previous.objectKey);
    }
    publicationStarted = true;
    const published = await repository.publishOutput(lease, {text:output.text,files:staged});
    if (published === false) {
      await Promise.all(staged.map(file => files.remove(file.objectKey)));
      return;
    }
  } catch (error) {
    // A rejected acknowledgement does not prove the transaction rolled back.
    // Once publication starts, leave uploaded objects to the reference-aware collector.
    if (!publicationStarted) await Promise.all(staged.map(file => files.remove(file.objectKey).catch(cleanupError => console.error('[workspace] staged cleanup failed', cleanupError instanceof Error ? cleanupError.name : 'UnknownError'))));
    throw error;
  }
  await Promise.all(superseded.map(key => files.remove(key).catch(error => console.error('[workspace] superseded cleanup failed',error instanceof Error ? error.name : 'UnknownError'))));
}

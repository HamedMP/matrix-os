import { describe, expect, it, vi } from 'vitest';
import { hydrateWorkspace, publishRuntimeOutput, parseQueuedJob } from '../../packages/workspace-worker/src/bridge.js';

describe('shared data/runtime composition', () => {
  it('hydrates only bounded owner files and refuses an incomplete projection', async () => {
    const pointer = {path:'notes/input.txt',objectKey:'key',revision:1};
    const repo = { listFiles: vi.fn().mockResolvedValue([pointer]), file:vi.fn().mockResolvedValue(pointer) };
    const files = {read:vi.fn().mockResolvedValue('saved input')};
    expect(await hydrateWorkspace(repo as never, files as never, 'owner')).toEqual([{path:'notes/input.txt',content:'saved input'}]);
    expect(repo.listFiles).toHaveBeenCalledWith('owner','',100);
    files.read.mockResolvedValue(null);
    await expect(hydrateWorkspace(repo as never, files as never, 'owner')).rejects.toThrow();
  });
  it('removes staged objects if publication loses its generation fence', async () => {
    const repo = {file:vi.fn().mockResolvedValue(null),publishOutput:vi.fn().mockRejectedValue(new Error('conflict'))};
    const files = {write:vi.fn().mockResolvedValue('staged'), remove:vi.fn()};
    await expect(publishRuntimeOutput(repo as never, files as never, {ownerId:'owner'} as never, {text:'done',files:[{path:'spike-result.txt',content:'ok'}]})).rejects.toThrow();
    expect(files.remove).toHaveBeenCalledWith('staged');
  });
  it('validates queue payloads and rejects owner/path injection before a DO call', () => {
    expect(parseQueuedJob({ownerId:'owner',jobId:'job',type:'wake'})).toEqual({ownerId:'owner',jobId:'job',type:'wake'});
    expect(()=>parseQueuedJob({ownerId:'../other',jobId:'job',type:'wake'})).toThrow();
    expect(()=>parseQueuedJob({ownerId:'owner',jobId:'job',type:'chat',message:'x'})).toThrow();
  });
});

describe('shared output publication retries and concurrent edits', () => {
  it('keeps the current R2 object when an already-published output is retried', async () => {
    const repo = {
      file: vi.fn().mockResolvedValue({objectKey:'current-live-object',revision:1}),
      publishOutput: vi.fn().mockResolvedValue(false),
    };
    const files = {write:vi.fn().mockResolvedValue('new-unreferenced-stage'),remove:vi.fn().mockResolvedValue(undefined)};
    await publishRuntimeOutput(repo as never, files as never, {ownerId:'owner'} as never,
      {text:'same completed output',files:[{path:'spike-result.txt',content:'saved'}]},new Map([['spike-result.txt',1]]));
    expect(files.remove).toHaveBeenCalledExactlyOnceWith('new-unreferenced-stage');
    expect(files.remove).not.toHaveBeenCalledWith('current-live-object');
  });
  it('retains the hydration revision so a newer browser file edit conflicts', async () => {
    const repo = {
      file:vi.fn().mockResolvedValue({objectKey:'browser-edited',revision:4}),
      publishOutput:vi.fn().mockRejectedValue(new Error('conflict')),
    };
    const files = {write:vi.fn().mockResolvedValue('agent-stage'),remove:vi.fn().mockResolvedValue(undefined)};
    await expect(publishRuntimeOutput(repo as never, files as never, {ownerId:'owner'} as never,
      {text:'agent output',files:[{path:'spike-result.txt',content:'agent edit'}]},new Map([['spike-result.txt',3]]))).rejects.toThrow('conflict');
    expect(repo.publishOutput.mock.calls[0][1].files[0]).toMatchObject({baseRevision:3});
    expect(files.remove).toHaveBeenCalledExactlyOnceWith('agent-stage');
    expect(files.remove).not.toHaveBeenCalledWith('browser-edited');
  });
});

describe('hydration revision/content consistency', () => {
  it('retries a pointer replaced while its old R2 object is being read', async () => {
    const { Kysely } = await import('kysely');
    const { createTestPGlite } = await import('../helpers/pglite-test-helper.js');
    const { PostgresWorkspaceRepository } = await import('../../packages/workspace-worker/src/data/repository.js');
    const engine = await createTestPGlite();
    const repository = new PostgresWorkspaceRepository(new Kysely({dialect:engine.dialect}));
    try {
      await repository.initialize();
      await repository.commitFile('hydration_owner','notes/input.txt','old-object',3,0);
      const files = {
        read:vi.fn(async (key:string) => {
          if (key === 'old-object') {
            await repository.commitFile('hydration_owner','notes/input.txt','new-object',7,1);
            return null; // Superseded old object deleted after the browser write.
          }
          return key === 'new-object' ? 'current' : null;
        }),
      };
      const revisions = new Map<string,number>();
      expect(await hydrateWorkspace(repository,files as never,'hydration_owner',revisions)).toEqual([{path:'notes/input.txt',content:'current'}]);
      expect(revisions.get('notes/input.txt')).toBe(2);
      expect(files.read).toHaveBeenCalledTimes(2);
    } finally { await repository.close(); if(!engine.client.closed) await engine.client.close(); }
  });
  it('never pairs superseded readable content with a newer revision and bounds retry churn', async () => {
    const { Kysely } = await import('kysely');
    const { createTestPGlite } = await import('../helpers/pglite-test-helper.js');
    const { PostgresWorkspaceRepository } = await import('../../packages/workspace-worker/src/data/repository.js');
    const engine = await createTestPGlite();
    const repository = new PostgresWorkspaceRepository(new Kysely({dialect:engine.dialect}));
    try {
      await repository.initialize();
      await repository.commitFile('churning_owner','notes/input.txt','object-1',3,0);
      let revision = 1;
      const files = { read:vi.fn(async () => {
        await repository.commitFile('churning_owner','notes/input.txt',`object-${revision + 1}`,3,revision);
        revision++;
        return 'old';
      }) };
      const revisions = new Map<string,number>();
      await expect(hydrateWorkspace(repository,files as never,'churning_owner',revisions)).rejects.toThrow();
      expect(files.read).toHaveBeenCalledTimes(3);
      expect(revisions.size).toBe(0);
    } finally { await repository.close(); if(!engine.client.closed) await engine.client.close(); }
  });
});

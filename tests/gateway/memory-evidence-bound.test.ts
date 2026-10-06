import { describe, expect, it } from 'vitest';
import { MemoryCompareRequestSchema, MemorySearchRequestSchema, type MemorySearchResult } from '@matrix-os/contracts';
import { validateMemoryEvidence, type MemoryDb } from '../../packages/gateway/src/memory-workspace/evidence.js';
const empty: MemorySearchResult = {engine:'hindsight',status:'ready',latencyMs:0,hits:[]};
describe('memory evidence admission bounds', () => {
  it('rejects excessive engine result groups before accessing storage', async () => {
    await expect(validateMemoryEvidence({} as MemoryDb, 'owner', Array.from({length:3},()=>empty))).rejects.toThrow('Memory evidence exceeds its bound');
  });
  it('rejects excessive hits before allocating a distinct-source collection or querying storage', async () => {
    const hit = {sourceId:'source',title:'Note',text:'Fact',provenance:'document' as const,citation:{sourceId:'source',revision:1,label:'Note'}};
    await expect(validateMemoryEvidence({} as MemoryDb,'owner',[{...empty,hits:Array.from({length:31},()=>hit)}])).rejects.toThrow('Memory evidence exceeds its bound');
  });
  it('retains the twenty-hit admission limit for public search and compare requests', () => {
    expect(MemorySearchRequestSchema.safeParse({query:'Question',engine:'hindsight',limit:20}).success).toBe(true);
    expect(MemorySearchRequestSchema.safeParse({query:'Question',engine:'hindsight',limit:21}).success).toBe(false);
    expect(MemoryCompareRequestSchema.safeParse({query:'Question',limit:20}).success).toBe(true);
    expect(MemoryCompareRequestSchema.safeParse({query:'Question',limit:21}).success).toBe(false);
  });
});

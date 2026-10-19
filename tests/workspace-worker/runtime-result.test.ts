import { describe, expect, it } from 'vitest';
import { parseGatewayResult, summarizeGatewayResult } from '../../packages/workspace-worker/runtime/result.mjs';

describe('actual gateway completion boundary', () => {
  it('accepts a successful real kernel result and joins streamed deltas', () => {
    const result = parseGatewayResult(JSON.stringify({events:[{type:'text',text:'Saved '},{type:'text',text:'file'},{type:'tool_start',tool:'Write'},{type:'result',data:{result:'Saved file',cost:0.01}}]}));
    expect(summarizeGatewayResult(result)).toEqual('Saved file');
  });
  it.each([
    {events:[{type:'result',data:{errors:['provider internal detail']}}]},
    {events:[{type:'aborted'}]}, {events:[{type:'refusal'}]}, {events:[]}, {},
  ])('does not acknowledge an unsuccessful agent run %j', (value) => {
    expect(() => parseGatewayResult(JSON.stringify(value))).toThrow('Agent execution failed');
  });
  it('rejects oversized result buffers', () => {
    expect(() => parseGatewayResult('x'.repeat(256_001))).toThrow('Agent result too large');
  });
});

describe('actual gateway session event identity', () => {
  it('extracts matching init and result session identity', () => {
    const sessionId = 'f46dd3a2-fb54-460c-883d-d8cce11f4fe3';
    expect(parseGatewayResult(JSON.stringify({events:[{type:'init',sessionId},{type:'result',data:{sessionId,result:'Done'}}]}), { requireSession: true }).sessionId).toBe(sessionId);
  });
  it.each([
    [{type:'init',sessionId:'wrong'}, {type:'result',data:{sessionId:'wrong',result:'Done'}}],
    [{type:'result',data:{result:'Done'}}],
    [{type:'init',sessionId:'f46dd3a2-fb54-460c-883d-d8cce11f4fe3'},{type:'result',data:{sessionId:'326f3235-4e3d-48e6-898f-a7b522c531b7',result:'Done'}}],
    [null],
  ].map(events => ({ events })))('rejects missing or inconsistent SDK identity', ({ events }) => {
    expect(() => parseGatewayResult(JSON.stringify({events}), { requireSession: true })).toThrow('Agent execution failed');
  });
});

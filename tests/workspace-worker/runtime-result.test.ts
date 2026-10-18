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

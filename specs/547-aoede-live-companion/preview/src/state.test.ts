import { describe, expect, it } from 'vitest';
import { initialState, reducer } from './state';
describe('voice preview lifecycle and action boundaries', () => {
  it('keeps a running build when voice ends', () => {
    const building = reducer(initialState, { type: 'scenario', scenario: 'build' });
    const ended = reducer(building, { type: 'voice', active: false });
    expect(ended.build).toBe(1);
    expect(ended.active).toBe(false);
  });
  it('cannot run a terminal command before an approval request', () => {
    expect(reducer(initialState, { type: 'approve' }).terminal).toBe('idle');
    const pending = reducer(initialState, { type: 'scenario', scenario: 'terminal' });
    expect(pending.terminal).toBe('approval');
    expect(reducer(pending, { type: 'reject' }).terminal).toBe('rejected');
    expect(reducer(pending, { type: 'approve' }).terminal).toBe('running');
  });
  it('ignores progress from a replaced demonstration', () => {
    const old = reducer(initialState, { type: 'scenario', scenario: 'build' });
    const current = reducer(old, { type: 'scenario', scenario: 'context' });
    expect(reducer(current, { type: 'progress', generation: old.generation, step: 4 }).build).toBe(0);
  });
  it('cannot open a generated app before completion', () => {
    const pending = reducer(initialState, { type: 'scenario', scenario: 'build' });
    expect(reducer(pending, { type: 'open', app: 'Leaf' }).app).toBe('Chat');
    const ready = reducer(pending, { type: 'progress', generation: pending.generation, step: 4 });
    expect(reducer(ready, { type: 'open', app: 'Leaf' }).app).toBe('Leaf');
  });
});

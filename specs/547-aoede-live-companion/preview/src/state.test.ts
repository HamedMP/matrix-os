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
  it('ignores progress after an explicit Reset', () => {
    const old = reducer(initialState, { type: 'scenario', scenario: 'build' });
    const current = reducer(old, { type: 'reset' });
    expect(reducer(current, { type: 'progress', generation: old.generation, step: 4 }).build).toBe(0);
  });
  it('retains task identity and progress while retrieving an earlier chat', () => {
    const started = reducer(initialState, { type: 'scenario', scenario: 'build' });
    const building = reducer(started, { type: 'progress', generation: started.generation, step: 2 });
    const recalled = reducer(building, { type: 'scenario', scenario: 'context' });
    expect(recalled.build).toBe(2);
    expect(recalled.generation).toBe(building.generation);
    expect(recalled.app).toBe('Notes');
    expect(reducer(recalled, { type: 'progress', generation: started.generation, step: 4 }).build).toBe(4);
  });
  it('retrieval does not discard a pending terminal approval', () => {
    const pending = reducer(initialState, { type: 'scenario', scenario: 'terminal' });
    const recalled = reducer(pending, { type: 'scenario', scenario: 'context' });
    expect(recalled.terminal).toBe('approval');
  });
  it('keeps a build progressing while a separate terminal approval is shown', () => {
    const building = reducer(initialState, { type: 'scenario', scenario: 'build' });
    const terminal = reducer(building, { type: 'scenario', scenario: 'terminal' });
    expect(terminal.build).toBe(1);
    expect(terminal.generation).toBe(building.generation);
    expect(terminal.terminal).toBe('approval');
    expect(reducer(terminal, { type: 'progress', generation: building.generation, step: 4 }).build).toBe(4);
  });
  it('cannot open a generated app before completion', () => {
    const pending = reducer(initialState, { type: 'scenario', scenario: 'build' });
    expect(reducer(pending, { type: 'open', app: 'Leaf' }).app).toBe('Chat');
    const ready = reducer(pending, { type: 'progress', generation: pending.generation, step: 4 });
    expect(reducer(ready, { type: 'open', app: 'Leaf' }).app).toBe('Leaf');
  });
});

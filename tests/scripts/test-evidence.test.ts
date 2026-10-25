import { describe, expect, it } from "vitest";
import { analyzeTestEvidence } from "../../scripts/testing/test-evidence.mjs";

const file = "tests/shell/reducer.test.ts";
function analyze(source: string) { return analyzeTestEvidence(source, file).tests; }

describe("per-test structural evidence", () => {
  it("finds local replicas inside mixed suites without assigning file-wide production coverage", () => {
    const rows = analyze(`import { reducer } from '../../shell/src/reducer';
      function replica(state) { return state + 1; }
      it('real', () => expect(reducer(1)).toBe(2));
      it('copy', () => expect(replica(1)).toBe(2));`);
    expect(rows.map(row => row.title)).toEqual(["real", "copy"]);
    expect(rows[0].classification).toBe("production-referenced");
    expect(rows[1].classification).toBe("local-only-candidate");
    expect(rows[1].productionBindings).toEqual([]);
    expect(rows.every(row => row.evidenceDepth === "structural-source-screen")).toBe(true);
  });

  it("recognizes aliased node:test registrations without expanding case counts", () => {
    const [row] = analyze(`import { test as check } from 'node:test';
      import { reducer } from '../../shell/src/reducer';
      check('node case', () => expect(reducer(1)).toBe(2));`);
    expect(row).toMatchObject({ title: "node case", parameterized: false, classification: "production-referenced" });
  });

  it("follows local wrappers and immutable aliases to production bindings", () => {
    const [row] = analyze(`import { reduce as runtime } from '../../shell/src/reducer';
      const alias = runtime; const wrapped = value => alias(value);
      function run(value) { return wrapped(value); }
      it('wrapper', () => expect(run(1)).toBe(2));`);
    expect(row.productionBindings.map(binding => binding.name)).toEqual(["runtime"]);
  });

  it("does not treat type-only imports as executable production dependencies", () => {
    const [row] = analyze(`import type { State } from '../../shell/src/reducer';
      import { type Event } from '../../shell/src/events';
      function replica(state: State, event: Event) { return state; }
      it('types', () => expect(replica({}, {})).toEqual({}));`);
    expect(row.productionBindings).toEqual([]);
    expect(row.classification).toBe("local-only-candidate");
  });

  it("follows runtime class extends while excluding implements and generic type arguments", () => {
    const rows = analyze(`import { Runtime, Contract, State } from '../../shell/src/runtime';
      import { Socket } from '../helpers/socket';
      class Real extends Runtime<State> implements Contract {}
      class Capture extends Socket<State> implements Contract {}
      class Local implements Contract {}
      it('real subclass', () => expect(new Real()).toBeDefined());
      it('helper subclass', () => expect(new Capture()).toBeDefined());
      it('type contract', () => expect(new Local()).toBeDefined());`);
    expect(rows[0].productionBindings.map(binding => binding.name)).toEqual(["Runtime"]);
    expect(rows[1].helperBindings.map(binding => binding.name)).toEqual(["Socket"]);
    expect(rows[1].productionBindings).toEqual([]);
    expect(rows[1].classification).toBe("helper-driven-needs-review");
    expect(rows[2].productionBindings).toEqual([]);
  });

  it("respects callback shadowing rather than resolving a local replica to an import", () => {
    const [row] = analyze(`import { reducer } from '../../shell/src/reducer';
      it('shadow', () => { const reducer = value => value + 1; expect(reducer(1)).toBe(2); });`);
    expect(row.productionBindings).toEqual([]);
    expect(row.classification).toBe("local-only-candidate");
  });

  it("does not leak constructor or loop bindings into unrelated tests", () => {
    const [row] = analyze(`import { reducer } from '../../shell/src/reducer';
      class Fixture { constructor(reducer) {} }
      for (const reducer of []) {}
      it('real', () => expect(reducer(1)).toBe(2));`);
    expect(row.productionBindings.map(binding => binding.name)).toEqual(["reducer"]);
  });

  it("does not invent registrations or imports from strings, comments, or local test functions", () => {
    expect(analyze(`// it('comment', () => {})
      const source = "it('string', () => fake())";
      function test(name, action) {} test('local function', () => {});`)).toEqual([]);
  });

  it("recognizes framework aliases, parameterization and conditional registration once", () => {
    const rows = analyze(`import { it as check, test } from 'vitest';
      check.each([1,2])('value %s', value => expect(value).toBeDefined());
      test.skipIf(process.env.CI)('optional', () => expect(true).toBe(true));
      test.todo('later');`);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ title: "value %s", parameterized: true, line: 2 });
    expect(rows[1].signals).toContain("conditional-registration");
    expect(rows[2].modifiers).toContain("todo");
  });

  it("follows immutable registration aliases with modifiers and stops cyclic or custom factories", () => {
    const rows = analyze(`import { it } from 'vitest';
      const nativeIt = it.runIf(process.platform === 'linux');
      const alias = nativeIt; alias('native case', () => expect(true).toBe(true));
      const table = it.each([1, 2]); table('value %s', value => expect(value).toBeDefined());
      const cycleA = cycleB; const cycleB = cycleA; cycleA('cycle', () => {});
      const custom = createTest(it); custom('unsupported factory', () => {});`);
    expect(rows.map(row => row.title)).toEqual(["native case", "value %s"]);
    expect(rows[0].modifiers).toContain("runIf");
    expect(rows[0].signals).toContain("conditional-registration");
    expect(rows[1].parameterized).toBe(true);
  });

  it("marks mutable bindings ambiguous instead of crediting a replaced production initializer", () => {
    const [row] = analyze(`import { reducer } from '../../shell/src/reducer';
      const replica = value => value + 1;
      let target = reducer; target = replica;
      it('replaced', () => expect(target(1)).toBe(2));`);
    expect(row.productionBindings).toEqual([]);
    expect(row.classification).toBe("needs-review");
    expect(row.signals).toContain("ambiguous-declaration");
  });

  it("keeps helpers and dynamic/source/process instrumentation out of automatic local-only candidates", () => {
    const rows = analyze(`import { harness } from '../helpers/harness';
      import { readFileSync as read } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      it('helper', () => expect(harness()).toBeDefined());
      it('dynamic', async () => { const runtime = await import('../../shell/src/reducer'); expect(runtime).toBeDefined(); });
      it('source', () => expect(read('source.ts','utf8')).toContain('guard'));
      it('process', () => expect(spawnSync('node',['runtime.mjs']).status).toBe(0));`);
    expect(rows.every(row => row.classification !== "local-only-candidate")).toBe(true);
    expect(rows[0].helperBindings.map(binding => binding.name)).toEqual(["harness"]);
    expect(rows[1].signals).toContain("dynamic-loader");
    expect(rows[2].signals).toContain("source-or-fixture-instrumentation");
    expect(rows[3].signals).toContain("process-instrumentation");
  });

  it("includes only lexical ancestor hooks, keeping hook evidence distinct from test body", () => {
    const rows = analyze(`import { boot } from '../../shell/src/runtime';
      import { readFileSync } from 'node:fs';
      describe('real', () => { beforeEach(() => boot()); it('a', () => expect(true).toBe(true)); });
      describe('source', () => { beforeEach(() => readFileSync('source')); it('b', () => expect(true).toBe(true)); });`);
    expect(rows[0].productionBindings).toEqual([]);
    expect(rows[0].hookProductionBindings.map(binding => binding.name)).toEqual(["boot"]);
    expect(rows[1].hookProductionBindings).toEqual([]);
    expect(rows[1].signals).toContain("hook-source-or-fixture-instrumentation");
  });

  it("flags unknown suite wrappers instead of declaring a gated local case disconnected", () => {
    const [row] = analyze(`const gated = process.env.CI ? describe : describe.skip;
      function replica(value) { return value; }
      gated('suite', () => { it('nested', () => expect(replica(1)).toBe(1)); });`);
    expect(row.signals).toContain("suite-context-unverified");
    expect(row.classification).toBe("needs-review");
  });

  it("handles recursive local functions without cycling and marks unresolved setup conservatively", () => {
    const [row] = analyze(`function replica(value) { return value > 0 ? replica(value-1) : 0; }
      it('ambiguous', () => { setupHarness(); expect(replica(1)).toBe(0); });`);
    expect(row.classification).toBe("needs-review");
    expect(row.signals).toContain("unresolved-reference");
  });
});

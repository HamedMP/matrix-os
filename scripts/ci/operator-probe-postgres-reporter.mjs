/** Required monetary lane: the optional local PG suite cannot silently qualify by skipping. */
export default class OperatorProbePostgresReporter {
  onTestRunEnd(modules) {
    const selected = modules.filter(module => module.relativeModuleId === 'tests/platform/operator-probe-budget-postgres.test.ts');
    const tests = selected.flatMap(module => [...module.children.allTests()]);
    if (selected.length !== 1 || selected[0].state() !== 'passed' || !tests.length
      || tests.some(test => test.result().state !== 'passed')) {
      throw new Error('Operator probe PostgreSQL qualification requires nonzero assertions and zero skips');
    }
  }
}

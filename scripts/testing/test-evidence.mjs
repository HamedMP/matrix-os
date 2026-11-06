/** Per-registration structural evidence only: no execution, score or deletion verdict. */
import path from 'node:path';
import ts from 'typescript';

const frameworks = new Set(['vitest', '@playwright/test', 'playwright/test', '@jest/globals', 'node:test']);
const hooks = new Set(['beforeAll', 'beforeEach', 'afterEach', 'afterAll']);
const factories = new Set(['each', 'skipIf', 'runIf', 'extend']);
const builtins = new Set(['expect', 'assert', 'vi', 'jest', 'describe', 'it', 'test', ...hooks,
  'undefined', 'NaN', 'Infinity', 'Array', 'Object', 'String', 'Number', 'Boolean', 'BigInt', 'Symbol',
  'Math', 'JSON', 'Date', 'RegExp', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'TypeError',
  'RangeError', 'URL', 'URLSearchParams', 'Buffer', 'Uint8Array', 'TextEncoder', 'TextDecoder',
  'console', 'process', 'globalThis', 'window', 'document', 'navigator', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'queueMicrotask', 'AbortController', 'AbortSignal', 'Request', 'Response',
  'Headers', 'Event', 'File', 'Blob', 'fetch', 'performance', '__dirname', '__filename']);
const isFunction = node => ts.isFunctionLike(node);
function importKind(source, filename) {
  if (frameworks.has(source)) return 'framework';
  if (source.startsWith('.')) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), source));
    return target.startsWith('tests/') || target.includes('/__tests__/') ? 'helper' : 'production';
  }
  return /^@(?:matrix-os|renderer|desktop)\//.test(source) || source.startsWith('@/') ? 'production' : 'external';
}
export function analyzeTestEvidence(source, filename = 'tests/unknown.test.ts') {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const scopes = new WeakMap();
  function declare(scope, name, value) {
    if (ts.isIdentifier(name)) scope.bindings.set(name.text, { name: name.text, ...value });
    else for (const element of name.elements ?? []) if (ts.isBindingElement(element)) declare(scope, element.name, { kind: 'ambiguous' });
  }
  function build(node, scope) {
    if (ts.isFunctionDeclaration(node) && node.name) declare(scope, node.name, { kind: 'local', node, callable: true });
    if (ts.isClassDeclaration(node) && node.name) declare(scope, node.name, { kind: 'local', node, callable: true });
    if (ts.isSourceFile(node) || ts.isBlock(node) || isFunction(node) || ts.isCatchClause(node) || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) scope = { parent: scope, bindings: new Map() };
    scopes.set(node, scope);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause, from = node.moduleSpecifier.text, kind = importKind(from, filename);
      if (clause?.name) declare(scope, clause.name, { kind: clause.isTypeOnly ? 'type' : kind, source: from, imported: 'default' });
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) declare(scope, clause.namedBindings.name, { kind: clause.isTypeOnly ? 'type' : kind, source: from, imported: '*' });
        else for (const binding of clause.namedBindings.elements) declare(scope, binding.name,
          { kind: clause.isTypeOnly || binding.isTypeOnly ? 'type' : kind, source: from, imported: (binding.propertyName ?? binding.name).text });
      }
    }
    if (ts.isVariableDeclaration(node)) declare(scope, node.name, {
      kind: ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) ? 'local' : 'ambiguous',
      node: node.initializer, callable: Boolean(node.initializer && (isFunction(node.initializer) || ts.isClassExpression(node.initializer))),
    });
    if (ts.isParameter(node)) declare(scope, node.name, { kind: 'parameter' });
    node.forEachChild(child => build(child, scope));
  }
  build(tree, null);
  function binding(node) {
    for (let scope = scopes.get(node); scope; scope = scope.parent) if (scope.bindings.has(node.text)) return scope.bindings.get(node.text);
    return null;
  }
  function chain(expression, modifiers = [], seen = new Set()) {
    if (seen.has(expression)) return null;
    seen.add(expression);
    if (ts.isCallExpression(expression)) return ts.isPropertyAccessExpression(expression.expression)
      && factories.has(expression.expression.name.text) ? chain(expression.expression, modifiers, seen) : null;
    if (ts.isPropertyAccessExpression(expression)) {
      if (ts.isIdentifier(expression.expression)) {
        const owner = binding(expression.expression);
        if (owner?.kind === 'framework' && owner.imported === '*') return { name: expression.name.text, modifiers };
      }
      return chain(expression.expression, [expression.name.text, ...modifiers], seen);
    }
    if (!ts.isIdentifier(expression)) return null;
    const resolved = binding(expression);
    if (resolved?.kind === 'local' && resolved.node) return chain(resolved.node, modifiers, seen);
    if (resolved && resolved.kind !== 'framework' && resolved.kind !== 'helper') return null;
    return { name: resolved?.imported ?? expression.text, modifiers, uncertain: resolved?.kind === 'helper' };
  }
  function registration(node) {
    if (!ts.isCallExpression(node) || (ts.isPropertyAccessExpression(node.expression) && factories.has(node.expression.name.text))) return null;
    const info = chain(node.expression);
    return info && ['it', 'test', 'describe', ...hooks].includes(info.name) ? info : null;
  }
  function suites(node) {
    const result = [];
    for (let parent = node.parent; parent; parent = parent.parent) if (registration(parent)?.name === 'describe') result.push(parent);
    return result;
  }
  const registrations = [], hookNodes = [];
  function find(node) {
    const info = registration(node);
    if (info && hooks.has(info.name)) hookNodes.push({ node, owner: suites(node)[0] });
    if (info && ['it', 'test'].includes(info.name)) registrations.push({ node, info, suites: suites(node) });
    node.forEachChild(find);
  }
  find(tree);
  function evidence(rootNodes) {
    const production = new Map(), helpers = new Map(), locals = new Set(), signals = new Set(), seen = new Set();
    function visit(node) {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (ts.isExpressionWithTypeArguments(node)) {
        const heritage = node.parent;
        if (ts.isHeritageClause(heritage) && heritage.token === ts.SyntaxKind.ExtendsKeyword
          && (ts.isClassDeclaration(heritage.parent) || ts.isClassExpression(heritage.parent))) visit(node.expression);
        return;
      }
      if (ts.isTypeNode(node)) return;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) signals.add('dynamic-loader');
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression) && ['require', 'eval', 'Function'].includes(node.expression.text)) signals.add('dynamic-loader');
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && ['globalThis', 'window'].includes(node.expression.text)) signals.add('global-state-access');
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        if (parent && parent.name === node && !ts.isShorthandPropertyAssignment(parent)) return;
        const resolved = binding(node);
        if (resolved?.kind === 'production') production.set(resolved.name, { name: resolved.name, source: resolved.source });
        else if (resolved?.kind === 'helper') helpers.set(resolved.name, { name: resolved.name, source: resolved.source });
        else if (resolved?.kind === 'local') {
          if (resolved.callable) locals.add(resolved.name);
          if (!resolved.node) signals.add('ambiguous-declaration'); else visit(resolved.node);
        } else if (resolved?.kind === 'external') {
          if (/^(?:node:)?(?:fs|fs\/promises|vm)$/.test(resolved.source)) signals.add('source-or-fixture-instrumentation');
          else if (/^(?:node:)?(?:child_process|worker_threads)$/.test(resolved.source)) signals.add('process-instrumentation');
          else signals.add('external-dependency-reference');
        } else if (resolved?.kind === 'ambiguous') signals.add('ambiguous-declaration');
        else if (!resolved && !builtins.has(node.text)) signals.add('unresolved-reference');
      }
      node.forEachChild(visit);
    }
    rootNodes.forEach(visit);
    return { productionBindings: [...production.values()], helperBindings: [...helpers.values()], localCallables: [...locals].sort(), signals: [...signals].sort() };
  }
  const tests = registrations.map(({ node, info, suites: owners }) => {
    const own = evidence([...node.arguments].slice(1));
    const setup = evidence(hookNodes.filter(hook => !hook.owner || owners.includes(hook.owner)).flatMap(hook => [...hook.node.arguments]));
    const modifiers = [...new Set([...info.modifiers, ...owners.flatMap(owner => registration(owner).modifiers)])];
    const signals = [...new Set([...own.signals, ...setup.signals.map(signal => `hook-${signal}`)])];
    if (modifiers.some(modifier => ['skip', 'todo', 'skipIf', 'runIf'].includes(modifier))) signals.push('conditional-registration');
    if (info.uncertain) signals.push('registration-source-unverified');
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (isFunction(parent) && ts.isCallExpression(parent.parent)
        && parent.parent.arguments.includes(parent) && registration(parent.parent)?.name !== 'describe') signals.push('suite-context-unverified');
    }
    if (tree.parseDiagnostics.length) signals.push('source-parse-errors');
    const instrumented = signals.some(signal => /instrumentation|dynamic-loader|unresolved|ambiguous|global-state|external-dependency|unverified|parse-errors/.test(signal));
    const helperDriven = own.helperBindings.length || setup.helperBindings.length;
    const localOnly = own.localCallables.length && !own.productionBindings.length && !setup.productionBindings.length && !helperDriven && !instrumented;
    const title = node.arguments[0];
    return { title: title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title)) ? title.text : null,
      line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      parameterized: modifiers.includes('each'), modifiers, evidenceDepth: 'structural-source-screen',
      ...own, signals, hookProductionBindings: setup.productionBindings, hookHelperBindings: setup.helperBindings,
      classification: own.productionBindings.length ? 'production-referenced' : helperDriven ? 'helper-driven-needs-review' : localOnly ? 'local-only-candidate' : 'needs-review' };
  });
  return { schemaVersion: 1, filename, tests, limitations: [
    'Structural references are not runtime invocation or fault detection; imports may be mocked.',
    'Local-only is a review candidate, never a deletion verdict. Hook evidence is recorded separately.',
    'Lexical declarations are followed conservatively; dynamic registration, class properties and reflective loading need source review.',
    'Parameterized registrations are not expanded into fabricated runtime case counts.',
    'Only immutable registration aliases and known framework factories are followed; mutable bindings and custom factories need review.',
  ] };
}

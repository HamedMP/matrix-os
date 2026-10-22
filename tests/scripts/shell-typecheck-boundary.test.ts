import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type * as TypeScript from 'typescript';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const ts: typeof TypeScript = createRequire(join(root, 'shell/package.json'))('typescript');
function config(path: string) {
  const loaded = ts.readConfigFile(path, ts.sys.readFile);
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, resolve(path, '..'));
  expect(parsed.errors).toEqual([]);
  return parsed;
}

describe('production shell and E2E typecheck boundary', () => {
  it('keeps application and generated Next types in production while separately resolving screenshot fixture imports', () => {
    const production = config(join(root, 'shell/tsconfig.json'));
    const e2e = config(join(root, 'shell/tsconfig.e2e.json'));
    const screenshot = join(root, 'shell/e2e/bots/screenshots.spec.ts');
    expect(production.options.strict).toBe(true);
    expect(production.options.noEmit).toBe(true);
    expect(production.fileNames).toContain(join(root, 'shell/src/proxy.ts'));
    expect(production.fileNames.some(path => path.includes('/shell/e2e/'))).toBe(false);
    expect(e2e.fileNames).toContain(screenshot);
    expect(e2e.fileNames).toContain(join(root, 'shell/playwright.config.ts'));
    expect(e2e.options.strict).toBe(true);
    const fixture = ts.resolveModuleName('../../../tests/contracts/fixtures/canonical-chat.js', screenshot, e2e.options, ts.sys);
    expect(fixture.resolvedModule?.resolvedFileName).toBe(join(root, 'tests/contracts/fixtures/canonical-chat.ts'));
    const next = JSON.parse(readFileSync(join(root, 'shell/tsconfig.json'), 'utf8'));
    expect(next.include).toContain('.next/types/**/*.ts');
    expect(next.include).toContain('.next/dev/types/**/*.ts');
  });

  it('checks invalid application code without root fixtures and still rejects broken E2E code in its separate project', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'matrix-shell-typecheck-'));
    try {
      const shell = join(temporary, 'shell');
      mkdirSync(join(shell, 'src'), { recursive: true });
      mkdirSync(join(shell, 'e2e/bots'), { recursive: true });
      mkdirSync(join(shell, '.next/types'), { recursive: true });
      symlinkSync(join(root, 'node_modules'), join(temporary, 'node_modules'), 'dir');
      for (const name of ['tsconfig.json', 'tsconfig.e2e.json']) writeFileSync(join(shell, name), readFileSync(join(root, 'shell', name)));
      const app = join(shell, 'src/application.ts');
      const screenshot = join(shell, 'e2e/bots/screenshots.spec.ts');
      const generated = join(shell, '.next/types/routes.ts');
      writeFileSync(app, 'export const productionValue: number = "wrong";');
      writeFileSync(screenshot, 'import { fixture } from "../../../tests/contracts/fixtures/canonical-chat.js"; export const e2eValue: number = "wrong"; void fixture;');
      writeFileSync(generated, 'export const routeValue: number = "wrong";');
      const production = config(join(shell, 'tsconfig.json'));
      const e2e = config(join(shell, 'tsconfig.e2e.json'));
      const diagnostics = (parsed: TypeScript.ParsedCommandLine) => {
        const program = ts.createProgram(parsed.fileNames, { ...parsed.options, incremental: false });
        return program.getSemanticDiagnostics().filter(d => d.file?.fileName.startsWith(temporary));
      };
      const prodErrors = diagnostics(production);
      expect(prodErrors.map(d => [d.file?.fileName, d.code])).toEqual(expect.arrayContaining([[app, 2322], [generated, 2322]]));
      expect(prodErrors.some(d => d.file?.fileName === screenshot || d.code === 2307)).toBe(false);
      expect(diagnostics(e2e).map(d => d.code)).toEqual(expect.arrayContaining([2307, 2322]));
      mkdirSync(join(temporary, 'tests/contracts/fixtures'), { recursive: true });
      writeFileSync(join(temporary, 'tests/contracts/fixtures/canonical-chat.ts'), 'export const fixture = 1;');
      writeFileSync(screenshot, 'import { fixture } from "../../../tests/contracts/fixtures/canonical-chat.js"; export const e2eValue: number = fixture;');
      expect(diagnostics(e2e)).toEqual([]);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
});

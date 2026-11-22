import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Chat contracts in the production Node runtime", () => {
  it("loads and validates project setup through native Node import and require", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { createRequire } from 'node:module';
      const imported = await import('./packages/contracts/src/index.ts');
      const required = createRequire(import.meta.url)('./packages/contracts/src/index.ts');
      for (const contracts of [imported, required]) {
        const start = { clientRequestId: 'req_setup_native_smoke', answer: 'Build a portfolio' };
        if (!contracts.ProjectSetupStartRequestSchema.safeParse(start).success)
          throw new Error('Project setup start contract did not load');
        if (contracts.ProjectSetupStartRequestSchema.safeParse({ ...start, unexpected: true }).success)
          throw new Error('Project setup start contract is not strict');
        const update = { clientRequestId: 'req_setup_native_update', baseRevision: 0,
          action: { type: 'choose_skill', choice: 'skip' } };
        if (!contracts.ProjectSetupUpdateRequestSchema.safeParse(update).success)
          throw new Error('Project setup update contract did not load');
        if (!contracts.ProjectSetupResponseSchema.safeParse({ draft: null }).success)
          throw new Error('Project setup response contract did not load');
      }
      console.log('project-setup import and require loaded');
    `], {
      cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    expect(output.trim()).toBe("project-setup import and require loaded");
  });

  it("loads the contracts source without a bundler or TypeScript resolver", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { resolveChatAppReference } from './packages/contracts/src/index.ts';
      const app = resolveChatAppReference('~/apps/browser', [{ slug: 'browser', path: '__browser__' }]);
      if (app?.slug !== 'browser') throw new Error('App reference did not resolve');
      console.log('loaded');
    `], { cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 10_000 });
    expect(output.trim()).toBe("loaded");
  });
});

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Chat contracts in the production Node runtime", () => {
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

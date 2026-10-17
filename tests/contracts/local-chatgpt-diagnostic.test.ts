import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { ChatgptPlanDiagnosticSchema } from "../../packages/contracts/src/index.js";
import { ChatgptPlanDiagnosticSchema as DesktopDiagnosticSchema } from "../../desktop/src/shared/chatgpt-plan-ipc.js";

it("uses the same diagnostic schema at UI-contract and Desktop IPC boundaries", () => {
  expect(DesktopDiagnosticSchema).toBe(ChatgptPlanDiagnosticSchema);
});

it("loads the diagnostic contract through plain Node package-local aliases", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { ChatgptPlanDiagnosticSchema } from './packages/contracts/src/index.ts';
    const sample = { phase: 'status', category: 'unknown', at: '2026-10-16T06:00:00Z', correlationId: '829fe2b8-d668-4d3d-800e-79d201e80d53' };
    if (!ChatgptPlanDiagnosticSchema.safeParse(sample).success) throw new Error('Valid diagnostic rejected');
    if (ChatgptPlanDiagnosticSchema.safeParse({ ...sample, token: 'synthetic' }).success) throw new Error('Unexpected field accepted');
    console.log('loaded');
  `], { cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 10_000 });
  expect(output.trim()).toBe("loaded");
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

it("registers project deletion and starts recovery only after canonical Chat is initialized", () => {
  // Protect the production composition boundary: helper tests with pre-built
  // dependencies cannot catch permanently binding the unavailable callback.
  const server = readFileSync(join(process.cwd(), "packages/gateway/src/server.ts"), "utf8");
  const lifecycle = readFileSync(join(process.cwd(), "packages/gateway/src/server/workspace-lifecycle.ts"), "utf8");
  const chatReady = server.indexOf("canonicalChatOrchestrator = canonicalChatRuntime.orchestrator;");
  const lifecycleRegistration = server.indexOf("await registerWorkspaceLifecycle({");
  for (const position of [chatReady, lifecycleRegistration]) expect(position).toBeGreaterThan(0);
  expect(lifecycleRegistration).toBeGreaterThan(chatReady);
  expect(server.slice(lifecycleRegistration)).toContain("orchestrator: canonicalChatOrchestrator");

  const deleteBinding = lifecycle.indexOf("const deleteProjectChats =");
  const workspaceRoutes = lifecycle.indexOf('options.app.route("/", createWorkspaceRoutes(');
  const shellRoutes = lifecycle.indexOf('options.app.route("/api", options.shellRoutes)');
  const recovery = lifecycle.indexOf("const result = await recovery.run()");
  for (const position of [deleteBinding, workspaceRoutes, shellRoutes, recovery]) expect(position).toBeGreaterThan(0);
  expect(workspaceRoutes).toBeGreaterThan(deleteBinding);
  expect(recovery).toBeGreaterThan(deleteBinding);
  // Workspace must continue owning GET /api/sessions before the legacy mount.
  expect(shellRoutes).toBeGreaterThan(workspaceRoutes);
});

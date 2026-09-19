import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

it("registers project deletion and starts recovery only after canonical Chat is initialized", () => {
  // Protect the production composition boundary: helper tests with pre-built
  // dependencies cannot catch permanently binding the unavailable callback.
  const source = readFileSync(join(process.cwd(), "packages/gateway/src/server.ts"), "utf8");
  const chatReady = source.indexOf("canonicalChatOrchestrator = canonicalChatRuntime.orchestrator;");
  const deleteBinding = source.indexOf("const deleteProjectChats =");
  const workspaceRoutes = source.indexOf('app.route("/", createWorkspaceRoutes(');
  const shellRoutes = source.indexOf('app.route("/api", createShellRoutes(');
  const recovery = source.indexOf("await workspaceStartupRecoveryController.run()");
  for (const position of [chatReady, deleteBinding, workspaceRoutes, shellRoutes, recovery]) expect(position).toBeGreaterThan(0);
  expect(deleteBinding).toBeGreaterThan(chatReady);
  expect(workspaceRoutes).toBeGreaterThan(deleteBinding);
  expect(recovery).toBeGreaterThan(deleteBinding);
  // Workspace must continue owning GET /api/sessions before the legacy mount.
  expect(shellRoutes).toBeGreaterThan(workspaceRoutes);
});

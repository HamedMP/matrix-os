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

it("erases a deleted project's brain on both deletion paths, whether or not the brain started", () => {
  const read = (file: string) => readFileSync(join(process.cwd(), "packages/gateway/src", file), "utf8");
  const source = read("server.ts");
  const binding = source.indexOf(
    "const eraseProjectBrain = createBrainGatewayProjectErase(Boolean(databaseUrl), ownerDatabaseServices);",
  );
  const routes = source.indexOf('app.route("/", createWorkspaceRoutes(');
  const recovery = source.indexOf("createWorkspaceStartupRecovery({");
  for (const position of [binding, routes, recovery]) expect(position).toBeGreaterThan(0);
  expect(routes).toBeGreaterThan(binding);
  for (const [start, end] of [[routes, "\n  }));"], [recovery, "\n  });"]] as const) {
    expect(source.slice(start, source.indexOf(end, start))).toContain("\n    eraseProjectBrain,\n");
  }
  for (const file of ["workspace-routes.ts", "workspace-startup-recovery.ts"]) {
    expect(read(file), file).toContain("eraseBrain: options.eraseProjectBrain,");
  }
  expect(read("startup/owner-database.ts")).toContain("brainServices: BrainServicesHandle | null;");
});

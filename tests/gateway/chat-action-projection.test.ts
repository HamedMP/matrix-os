import { describe, expect, it } from "vitest";
import {
  CanonicalOperationSchema,
  CanonicalOperationViewSchema,
  type CanonicalOperation,
} from "@matrix-os/contracts";
import { toOperationView } from "../../packages/gateway/src/chat/action-projection.js";

const executionPolicy = {
  revision: "canonical_apps_v1_policy",
  actionMode: "canonical_actions" as const,
  workspaceScope: "apps",
  tools: [
    "matrix_open_app",
    "matrix_apply_app_files",
    "matrix_list_apps",
    "matrix_inspect_app",
    "matrix_search_workspace",
  ],
  delegation: false,
};

function operation(overrides: Partial<CanonicalOperation> = {}): CanonicalOperation {
  return CanonicalOperationSchema.parse({
    id: "action_projection_1",
    owner: { type: "personal", ownerId: "owner_1" },
    chatId: "chat_projection",
    runId: "run_projection",
    workspaceScope: "apps",
    policyRevision: executionPolicy.revision,
    executionPolicy,
    toolId: "matrix_open_app",
    schemaRevision: "canonical_apps_v1",
    arguments: { app: "timer", secret: "never-projected" },
    argumentDigest: "a".repeat(64),
    state: "succeeded",
    revision: 3,
    claimToken: "claim_secret_token",
    cancellationRequested: false,
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:01:00.000Z",
    ...overrides,
  });
}

describe("canonical operation client projection", () => {
  it("copies identity, policy and lifecycle fields but never arguments, claimToken or policy payloads", () => {
    const view = toOperationView(operation({ result: undefined }));
    expect(CanonicalOperationViewSchema.parse(view)).toEqual({
      id: "action_projection_1",
      chatId: "chat_projection",
      runId: "run_projection",
      toolId: "matrix_open_app",
      schemaRevision: "canonical_apps_v1",
      policyRevision: executionPolicy.revision,
      state: "succeeded",
      argumentDigest: "a".repeat(64),
      cancellationRequested: false,
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:01:00.000Z",
    });
    const keys = Object.keys(view).sort();
    expect(keys).not.toContain("arguments");
    expect(keys).not.toContain("claimToken");
    expect(keys).not.toContain("owner");
    expect(keys).not.toContain("executionPolicy");
    expect(keys).not.toContain("workspaceScope");
    expect(keys).not.toContain("revision");
  });

  it("projects only the navigation intent for matrix_open_app, dropping inspect payloads", () => {
    const view = toOperationView(operation({
      result: {
        app: "timer",
        name: "Timer",
        runtime: "vite",
        path: "apps/timer",
        files: [{ path: "src/main.tsx", sha256: "b".repeat(64), text: "file body", truncated: false }],
        navigation: { kind: "open_app", app: "timer", path: "apps/timer" },
      },
    }));
    expect(view.result).toEqual({
      navigation: { kind: "open_app", app: "timer", path: "apps/timer" },
    });
  });

  it("projects create-note navigation without exposing private note content", () => {
    const view = toOperationView(operation({
      toolId: "matrix_create_note",
      arguments: { app: "notes", title: "Groceries", content: "Private list" },
      result: { app: "notes", note: { id: "note-id", title: "Groceries" }, content: "Private list",
        navigation: { kind: "open_app", app: "notes", path: "apps/notes" } },
    }));
    expect(view.result).toEqual({ navigation: { kind: "open_app", app: "notes", path: "apps/notes" } });
  });

  it("projects bounded close-app intent without widening it to deletion", () => {
    const view = toOperationView(operation({
      toolId: "matrix_close_app",
      arguments: { app: "notes" },
      result: { app: "notes", navigation: { kind: "close_app", app: "notes", path: "apps/notes" } },
    }));
    expect(view.result).toEqual({ navigation: { kind: "close_app", app: "notes", path: "apps/notes" } });
  });

  it("projects apply_app_files artifact, navigation and hashed file list without contents", () => {
    const view = toOperationView(operation({
      toolId: "matrix_apply_app_files",
      result: {
        app: "timer",
        artifact: { kind: "app", path: "apps/timer" },
        navigation: { kind: "open_app", app: "timer", path: "apps/timer" },
        files: [
          { path: "src/main.tsx", sha256: "c".repeat(64) },
          { path: "src/App.tsx", sha256: "d".repeat(64), ignored: "field" },
        ],
      },
    }));
    expect(view.result).toEqual({
      artifact: { kind: "app", path: "apps/timer" },
      navigation: { kind: "open_app", app: "timer", path: "apps/timer" },
      files: [
        { path: "apps/timer/src/main.tsx", sha256: "c".repeat(64) },
        { path: "apps/timer/src/App.tsx", sha256: "d".repeat(64) },
      ],
    });
  });

  it("projects list_apps and inspect_app results while never exposing file text", () => {
    const listed = toOperationView(operation({
      toolId: "matrix_list_apps",
      result: { apps: [{ app: "timer", name: "Timer" }, { app: "notes", name: "Notes", extra: "dropped" }] },
    }));
    expect(listed.result).toEqual({ apps: [{ app: "timer", name: "Timer" }, { app: "notes", name: "Notes" }] });

    const inspected = toOperationView(operation({
      toolId: "matrix_inspect_app",
      result: {
        app: "timer",
        name: "Timer",
        runtime: "vite",
        path: "apps/timer",
        files: [{ path: "src/main.tsx", sha256: "e".repeat(64), text: "const secret = true", truncated: true }],
      },
    }));
    expect(inspected.result).toEqual({
      artifact: { kind: "app", path: "apps/timer" },
      files: [{ path: "apps/timer/src/main.tsx", sha256: "e".repeat(64), truncated: true }],
    });
    expect(JSON.stringify(inspected.result)).not.toContain("secret");
  });

  it("projects bounded search matches and caps files, apps and matches at 32", () => {
    const searched = toOperationView(operation({
      toolId: "matrix_search_workspace",
      result: {
        matches: Array.from({ length: 40 }, (_, index) => ({
          path: `apps/timer/src/f${index}.ts`,
          line: index + 1,
          text: `match ${index}`,
        })),
      },
    }));
    expect(searched.result?.matches).toHaveLength(32);
    expect(searched.result?.matches?.[0]).toEqual({ path: "apps/timer/src/f0.ts", line: 1, text: "match 0" });

    const applied = toOperationView(operation({
      toolId: "matrix_apply_app_files",
      arguments: { app: "timer", files: [] },
      result: {
        files: Array.from({ length: 40 }, (_, index) => ({ path: `src/f${index}.ts`, sha256: "f".repeat(64) })),
      },
    }));
    expect(applied.result?.files).toHaveLength(32);
  });

  it("drops the whole result for unknown tools or malformed whitelisted payloads", () => {
    for (const result of [
      { navigation: { kind: "open_app", app: "timer", path: "apps/timer" } },
      "raw text",
      { apps: "not-an-array" },
    ]) {
      expect(toOperationView(operation({ toolId: "external_unknown_tool", result })).result).toBeUndefined();
    }
    expect(toOperationView(operation({
      result: { navigation: { kind: "open_app", app: "timer", path: "apps/timer", leaked: "x" } },
    })).result?.navigation).toEqual({ kind: "open_app", app: "timer", path: "apps/timer" });
    expect(toOperationView(operation({
      result: { navigation: { kind: "redirect", app: "timer", path: "apps/timer" } },
    })).result).toBeUndefined();
    expect(toOperationView(operation({
      toolId: "matrix_inspect_app",
      result: { files: [{ path: "src/main.tsx", sha256: "e".repeat(64), text: "x" }] },
    })).result).toEqual({ files: [{ path: "apps/timer/src/main.tsx", sha256: "e".repeat(64) }] });
    expect(toOperationView(operation({
      toolId: "matrix_list_apps",
      result: { apps: [{ app: "ok", name: "Ok" }, { app: "../escape", name: "Bad" }] },
    })).result).toEqual({ apps: [{ app: "ok", name: "Ok" }] });
  });

  it("rejects cross-app and traversal paths instead of qualifying them", () => {
    const result = {
      app: "timer",
      artifact: { kind: "app", path: "apps/timer" },
      navigation: { kind: "open_app", app: "timer", path: "apps/timer" },
      files: [
        { path: "src/main.tsx", sha256: "a".repeat(64) },
        { path: "apps/notes/src/main.tsx", sha256: "b".repeat(64) },
        { path: "../notes/src/main.tsx", sha256: "c".repeat(64) },
      ],
    };
    expect(toOperationView(operation({
      toolId: "matrix_apply_app_files",
      arguments: { app: "timer", files: [{ path: "src/main.tsx", content: "x", expectedSha256: null }] },
      result,
    })).result).toEqual({
      artifact: { kind: "app", path: "apps/timer" },
      navigation: { kind: "open_app", app: "timer", path: "apps/timer" },
      files: [{ path: "apps/timer/src/main.tsx", sha256: "a".repeat(64) }],
    });
    expect(toOperationView(operation({
      toolId: "matrix_apply_app_files",
      arguments: { app: "timer", files: [] },
      result: { ...result, app: "notes" },
    })).result).toBeUndefined();
  });

  it("maps every lifecycle state straight through the view enum", () => {
    for (const state of [
      "proposed", "waiting_for_approval", "authorized", "running",
      "succeeded", "failed", "cancelled", "timed_out", "outcome_unknown",
    ] as const) {
      const view = toOperationView(operation({ state }));
      expect(view.state).toBe(state);
      expect(CanonicalOperationViewSchema.safeParse(view).success).toBe(true);
    }
    const requested = toOperationView(operation({ state: "running", cancellationRequested: true }));
    expect(requested.cancellationRequested).toBe(true);
  });
});

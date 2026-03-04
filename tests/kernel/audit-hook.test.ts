import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createFileAuditHook } from "../../packages/kernel/src/hooks.js";
import type { HookInput } from "../../packages/kernel/src/hooks.js";

function makeTempHome(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "audit-hook-")));
  mkdirSync(join(dir, "system", "logs"), { recursive: true });
  return dir;
}

function readAuditEntries(homePath: string) {
  const auditPath = join(homePath, "system", "logs", "audit.jsonl");
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("T1371: File audit hook", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = makeTempHome();
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("logs Write tool usage to audit.jsonl", async () => {
    const hook = createFileAuditHook(join(homePath, "system", "logs"));

    const input: HookInput = {
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "modules/app/index.html", content: "<html></html>" },
      session_id: "test-session",
    };

    await hook(input);

    const entries = readAuditEntries(homePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].op).toBe("write");
    expect(entries[0].path).toBe("modules/app/index.html");
    expect(entries[0].sizeBytes).toBeGreaterThan(0);
    expect(entries[0].actor).toBe("kernel");
  });

  it("logs Edit tool usage to audit.jsonl", async () => {
    const hook = createFileAuditHook(join(homePath, "system", "logs"));

    const input: HookInput = {
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "modules/app/style.css", new_string: "body { color: red; }" },
      session_id: "test-session",
    };

    await hook(input);

    const entries = readAuditEntries(homePath);
    expect(entries).toHaveLength(1);
    expect(entries[0].op).toBe("write");
    expect(entries[0].path).toBe("modules/app/style.css");
  });

  it("ignores non-file-mutation tools", async () => {
    const hook = createFileAuditHook(join(homePath, "system", "logs"));

    const input: HookInput = {
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "modules/app/index.html" },
      session_id: "test-session",
    };

    await hook(input);

    const entries = readAuditEntries(homePath);
    expect(entries).toHaveLength(0);
  });

  it("ignores PreToolUse events", async () => {
    const hook = createFileAuditHook(join(homePath, "system", "logs"));

    const input: HookInput = {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "test.txt", content: "hello" },
      session_id: "test-session",
    };

    await hook(input);

    const entries = readAuditEntries(homePath);
    expect(entries).toHaveLength(0);
  });

  it("ignores tools without file_path", async () => {
    const hook = createFileAuditHook(join(homePath, "system", "logs"));

    const input: HookInput = {
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: {},
      session_id: "test-session",
    };

    await hook(input);

    const entries = readAuditEntries(homePath);
    expect(entries).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import { codexCommandPreview } from "../../packages/gateway/src/coding-agents/codex-command-preview.mjs";
import { openToolPreview } from "../../packages/gateway/src/coding-agents/protected-tool-output.mjs";
import { CanonicalChatCommandPreviewSchema } from "@matrix-os/contracts";
const key = Buffer.alloc(32, 3);

describe("bounded owner command evidence", () => {
  it.each([
    "echo API_KEY=qa-fake", "echo AWS_SECRET_ACCESS_KEY=qa-fake", "echo SESSION_ID=qa-fake",
    'curl -H "Authorization: Basic dXNlcjpwYXNz" /api/apps', "curl --token qa-fake",
    "echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c3ludGhldGlj",
  ])("withholds recognized credential values rather than persisting them: %s", command => {
    expect(codexCommandPreview(command, "command_test", key)).toEqual({});
    expect(CanonicalChatCommandPreviewSchema.safeParse(command).success).toBe(false);
  });
  it.each(["cat /home/matrix/home/.env /home/matrix/home/auth.json", "printf token; echo $TOKEN", "cat /root/.ssh/id_rsa", "printf one\nprintf two"]) (
    "does not classify owner paths or identifiers as credential values: %s", command => {
      const preview = codexCommandPreview(command, "command_test", key);
      expect(preview.protectedPreview).toBeDefined();
      expect(openToolPreview(key, "command_test", preview.protectedPreview)).toBe(command);
    });
  it.each(["x".repeat(4001), "printf \u0000", "printf \u001b[0m", "   "]) ("rejects invalid bounded command evidence", command => {
    expect(codexCommandPreview(command, "command_test", key)).toEqual({});
  });
  it.each([
    "cat /home/matrix/home/projects/demo/README.md\n" + "printf synthetic-line\n".repeat(70).trim(),
    "printf " + "x".repeat(3993),
  ])("uses the extended protected bound without expanding plaintext previews", command => {
    expect(command.length).toBeGreaterThan(1000);
    const preview = codexCommandPreview(command, "command_test", key);
    expect(preview.protectedPreview).toBeDefined();
    expect(preview).not.toHaveProperty("preview");
    expect(openToolPreview(key, "command_test", preview.protectedPreview)).toBe(command);
    expect(CanonicalChatCommandPreviewSchema.safeParse(command).success).toBe(true);
    expect(codexCommandPreview(command, "command_test", undefined)).toEqual({});
  });

  it("uses only the safe fallback when no protection key is available", () => {
    expect(codexCommandPreview("printf ok", "command_test", undefined)).toEqual({ preview: "printf ok", previewKind: "command" });
    expect(codexCommandPreview("cat /home/matrix/home/projects/demo/README.md", "command_test", undefined)).toEqual({});
    expect(codexCommandPreview("printf one\nprintf two", "command_test", undefined)).toEqual({});
  });
});

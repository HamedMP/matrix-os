import { describe, expect, it } from "vitest";
import { ChatRunContextSchema } from "@matrix-os/contracts";
import { validateQueuedAgentDriver } from "../../packages/gateway/src/chat/queued-context.js";
const context = ChatRunContextSchema.parse({ version: 1, requestHash: "a".repeat(64), chats: [], drives: [{ kind: "drive", organizationId: "org_company", scopeId: "00000000-0000-4000-8000-000000000001" }] });
describe("persisted drive context dispatch", () => {
    it("rejects queued drive context on an unsupported harness before admission", () => {
        expect(() => validateQueuedAgentDriver(context, "codex", "chat_drive", 1)).toThrow();
        expect(() => validateQueuedAgentDriver(context, "claude_code", "chat_drive", 1)).not.toThrow();
        expect(() => validateQueuedAgentDriver(undefined, "codex", "chat_drive", 1)).not.toThrow();
    });
});

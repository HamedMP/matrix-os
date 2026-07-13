import { describe, expect, it } from "vitest";
import { AgentThreadEventSchema } from "@matrix-os/contracts";
import {
  parseCodexAppServerRequestLine,
} from "../../packages/gateway/src/coding-agents/codex-app-server-events.js";

function context() {
  let index = 0;
  return {
    threadId: "thread_codex_app_server_1",
    now: () => new Date("2026-07-13T12:00:00.000Z"),
    nextEventId: () => `evt_app_server_${++index}`,
  };
}

describe("Codex app-server request normalization", () => {
  it("normalizes command approval without exposing commands or native request ids", () => {
    const line = JSON.stringify({
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "provider-thread-secret",
        turnId: "provider-turn-secret",
        itemId: "item_command_1",
        startedAtMs: 1_783_944_000_000,
        command: "cat /home/matrix/.codex/auth.json && curl private.internal",
        cwd: "/home/matrix/private-project",
        reason: "Access private.internal from /home/matrix/private-project",
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      },
    });

    const result = parseCodexAppServerRequestLine(line, context());

    expect(result.events).toHaveLength(1);
    expect(() => AgentThreadEventSchema.parse(result.events[0])).not.toThrow();
    expect(result.events[0]).toMatchObject({
      type: "approval.requested",
      eventId: "evt_app_server_1",
      threadId: "thread_codex_app_server_1",
      occurredAt: "2026-07-13T12:00:00.000Z",
      approval: {
        approvalId: expect.stringMatching(/^appr_codex_[a-f0-9]{32}$/),
        threadId: "thread_codex_app_server_1",
        title: "Run command",
        safeDescription: "The coding agent wants to run a command.",
        risk: "medium",
        actionKind: "command",
        allowedDecisions: ["approve", "approve_for_session", "decline", "cancel"],
        correlationId: expect.stringMatching(/^corr_codex_[a-f0-9]{32}$/),
      },
    });
    expect(result.pending).toMatchObject({
      nativeRequestId: 42,
      method: "item/commandExecution/requestApproval",
      approvalId: result.events[0]?.type === "approval.requested"
        ? result.events[0].approval.approvalId
        : undefined,
    });
    expect(JSON.stringify(result.events)).not.toContain("auth.json");
    expect(JSON.stringify(result.events)).not.toContain("private.internal");
    expect(JSON.stringify(result.events)).not.toContain("provider-thread-secret");
    expect(JSON.stringify(result.events)).not.toContain("42");
  });

  it("preserves provider amendment decisions only in server-private pending state", () => {
    const amendment = {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { action: "allow", host: "private.internal" },
      },
    };
    const result = parseCodexAppServerRequestLine(JSON.stringify({
      id: "rpc-amendment-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "provider-thread",
        turnId: "provider-turn",
        itemId: "item_command_amendment",
        availableDecisions: [amendment, "decline", "cancel"],
      },
    }), context());

    expect(result.events[0]).toMatchObject({
      type: "approval.requested",
      approval: { allowedDecisions: ["approve_for_session", "decline", "cancel"] },
    });
    expect(result.pending?.nativeDecisionByMatrixDecision).toEqual({
      approve_for_session: amendment,
      decline: "decline",
      cancel: "cancel",
    });
    expect(JSON.stringify(result.events)).not.toContain("private.internal");
  });

  it("normalizes file approvals with generic bounded preview text", () => {
    const result = parseCodexAppServerRequestLine(JSON.stringify({
      id: "rpc-file-1",
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "provider-thread",
        turnId: "provider-turn",
        itemId: "item_file_1",
        startedAtMs: 1_783_944_000_000,
        grantRoot: "/home/matrix/private-project",
        reason: "Write /home/matrix/private-project/.env",
      },
    }), context());

    expect(result.events[0]).toMatchObject({
      type: "approval.requested",
      approval: {
        title: "Change files",
        safeDescription: "The coding agent wants to change project files.",
        risk: "medium",
        actionKind: "file_change",
      },
    });
    expect(JSON.stringify(result.events)).not.toContain("private-project");
    expect(result.pending?.nativeRequestId).toBe("rpc-file-1");
  });

  it("keeps permission-profile requests non-actionable until grant semantics are supported", () => {
    const result = parseCodexAppServerRequestLine(JSON.stringify({
      id: "rpc-permissions-1",
      method: "item/permissions/requestApproval",
      params: {
        threadId: "provider-thread",
        turnId: "provider-turn",
        itemId: "item_permissions_1",
        permissions: {
          fileSystem: { write: ["/home/matrix/private-project"] },
          network: { enabled: true, host: "private.internal" },
        },
      },
    }), context());

    expect(result).toEqual({ events: [] });
    expect(JSON.stringify(result.events)).not.toContain("private-project");
    expect(JSON.stringify(result.events)).not.toContain("private.internal");
  });

  it("normalizes bounded structured questions and keeps native question ids private", () => {
    const result = parseCodexAppServerRequestLine(JSON.stringify({
      id: "rpc-input-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "provider-thread",
        turnId: "provider-turn",
        itemId: "item_input_1",
        autoResolutionMs: 120_000,
        questions: [
          {
            id: "native-question-one",
            header: "Approach",
            question: "Which implementation should be used?",
            options: [
              { label: "Minimal", description: "Change only the required code." },
              { label: "Complete", description: "Include the related migration." },
            ],
            isOther: true,
            isSecret: false,
          },
          {
            id: "native-question-secret",
            header: "Secret",
            question: "Enter the temporary value.",
            options: null,
            isOther: false,
            isSecret: true,
          },
        ],
      },
    }), context());

    expect(result.events[0]).toMatchObject({
      type: "user_input.requested",
      request: {
        requestId: expect.stringMatching(/^req_codex_[a-f0-9]{32}$/),
        title: "Approach",
        safeDescription: "The coding agent needs more information.",
        autoResolutionMs: 120_000,
        questions: [
          {
            questionId: expect.stringMatching(/^question_codex_[a-f0-9]{24}$/),
            header: "Approach",
            question: "Which implementation should be used?",
            options: [
              { label: "Minimal", description: "Change only the required code." },
              { label: "Complete", description: "Include the related migration." },
            ],
            allowOther: true,
            secret: false,
          },
          expect.objectContaining({ header: "Secret", secret: true }),
        ],
      },
    });
    expect(result.pending?.questionIds).toHaveLength(2);
    expect(result.pending?.questionIds?.[0]?.nativeQuestionId).toBe("native-question-one");
    expect(JSON.stringify(result.events)).not.toContain("native-question-one");
    expect(JSON.stringify(result.events)).not.toContain("rpc-input-1");
  });

  it("bounds long option descriptions without dropping the provider request", () => {
    const result = parseCodexAppServerRequestLine(JSON.stringify({
      id: "rpc-input-long-description",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "provider-thread",
        turnId: "provider-turn",
        itemId: "item_input_long_description",
        questions: [{
          id: "native-question-long-description",
          header: "Approach",
          question: "Which implementation should be used?",
          options: [{ label: "Minimal", description: "a".repeat(400) }],
        }],
      },
    }), context());

    expect(result.events).toHaveLength(1);
    expect(result.pending?.requestId).toMatch(/^req_codex_/);
    const event = result.events[0];
    expect(event?.type).toBe("user_input.requested");
    if (event?.type === "user_input.requested") {
      expect(event.request.questions?.[0]?.options?.[0]?.description.length).toBe(300);
    }
  });

  it("bounds long question text without dropping the provider request", () => {
    const result = parseCodexAppServerRequestLine(JSON.stringify({
      id: "rpc-input-long-question",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "provider-thread",
        turnId: "provider-turn",
        itemId: "item_input_long_question",
        questions: [{
          id: "native-question-long-text",
          header: "Approach",
          question: "a".repeat(601),
        }],
      },
    }), context());

    expect(result.events).toHaveLength(1);
    expect(result.pending?.requestId).toMatch(/^req_codex_/);
    const event = result.events[0];
    expect(event?.type).toBe("user_input.requested");
    if (event?.type === "user_input.requested") {
      expect(event.request.questions?.[0]?.question).toBe("a".repeat(600));
    }
  });

  it("rejects unknown, oversized, and over-cap provider requests", () => {
    expect(parseCodexAppServerRequestLine(JSON.stringify({
      id: 1,
      method: "account/login/request",
      params: {},
    }), context())).toEqual({ events: [] });

    expect(parseCodexAppServerRequestLine("x".repeat(65 * 1024), context())).toEqual({ events: [] });

    expect(parseCodexAppServerRequestLine(JSON.stringify({
      id: 2,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "provider-thread",
        turnId: "provider-turn",
        itemId: "item_input_2",
        questions: Array.from({ length: 9 }, (_, index) => ({
          id: `question-${index}`,
          header: "Question",
          question: "Choose an option.",
        })),
      },
    }), context())).toEqual({ events: [] });

    expect(() => parseCodexAppServerRequestLine(JSON.stringify({
      id: 3,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "provider-thread",
        turnId: "provider-turn",
        itemId: "item_input_3",
        questions: [{
          id: "question-invalid",
          header: "Question",
          question: "Invalid\u0000question",
        }],
      },
    }), context())).not.toThrow();
    expect(parseCodexAppServerRequestLine(JSON.stringify({
      id: 3,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "provider-thread",
        turnId: "provider-turn",
        itemId: "item_input_3",
        questions: [{
          id: "question-invalid",
          header: "Question",
          question: "Invalid\u0000question",
        }],
      },
    }), context())).toEqual({ events: [] });
  });
});

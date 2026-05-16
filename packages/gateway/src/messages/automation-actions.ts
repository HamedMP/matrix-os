import type { AutomationAction } from "./schemas.js";

export interface AutomationActionRunnerInput {
  ownerId: string;
  ruleId: string;
  roomId: string;
  body: string;
  action: AutomationAction;
}

export interface AutomationActionRunnerDeps {
  createTask: (input: { ownerId: string; title: string }) => Promise<string>;
  createDraft: (input: { ownerId: string; roomId: string; ruleId: string; body: string }) => Promise<string>;
}

export function renderAutomationTemplate(template: string, body: string, maxLength: number): string {
  return template.replaceAll("{body}", body).slice(0, maxLength);
}

export function createAutomationActionRunner(deps: AutomationActionRunnerDeps) {
  return async function runAutomationAction(input: AutomationActionRunnerInput): Promise<{ ok: true; taskId?: string; draftReplyId?: string }> {
    if (input.action.type === "create_task") {
      const taskId = await deps.createTask({
        ownerId: input.ownerId,
        title: renderAutomationTemplate(input.action.titleTemplate, input.body, 160),
      });
      return { ok: true, taskId };
    }
    const draftReplyId = await deps.createDraft({
      ownerId: input.ownerId,
      roomId: input.roomId,
      ruleId: input.ruleId,
      body: renderAutomationTemplate(input.action.bodyTemplate, input.body, 1_000),
    });
    return { ok: true, draftReplyId };
  };
}

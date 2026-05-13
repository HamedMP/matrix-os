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
}

function renderTemplate(template: string, body: string): string {
  return template.replaceAll("{body}", body).slice(0, 160);
}

export function createAutomationActionRunner(deps: AutomationActionRunnerDeps) {
  return async function runAutomationAction(input: AutomationActionRunnerInput): Promise<{ ok: true; taskId?: string; draftBody?: string }> {
    if (input.action.type === "create_task") {
      const taskId = await deps.createTask({
        ownerId: input.ownerId,
        title: renderTemplate(input.action.titleTemplate, input.body),
      });
      return { ok: true, taskId };
    }
    return {
      ok: true,
      draftBody: renderTemplate(input.action.bodyTemplate, input.body),
    };
  };
}

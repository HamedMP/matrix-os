import type { AutomationAction, AutomationRule, HermesPermission } from "./schemas.js";

export interface AutomationEvent {
  ownerId: string;
  roomId: string;
  body: string;
}

export interface AutomationActionInvocation {
  ownerId: string;
  ruleId: string;
  roomId: string;
  body: string;
  action: AutomationAction;
}

export interface EvaluateAutomationRulesInput {
  event: AutomationEvent;
  permission: HermesPermission | null;
  rules: AutomationRule[];
  runAction: (invocation: AutomationActionInvocation) => Promise<unknown>;
}

export async function evaluateAutomationRules(input: EvaluateAutomationRulesInput): Promise<{ executed: number }> {
  if (!input.permission?.automationEnabled) return { executed: 0 };

  let executed = 0;
  for (const rule of input.rules) {
    if (rule.status !== "enabled") continue;
    if (rule.scope === "room" && rule.roomId !== input.event.roomId) continue;
    if (rule.trigger.type === "text_contains" && !input.event.body.toLowerCase().includes(rule.trigger.value.toLowerCase())) {
      continue;
    }
    await input.runAction({
      ownerId: input.event.ownerId,
      ruleId: rule.id,
      roomId: input.event.roomId,
      body: input.event.body,
      action: rule.action,
    });
    executed += 1;
  }

  return { executed };
}

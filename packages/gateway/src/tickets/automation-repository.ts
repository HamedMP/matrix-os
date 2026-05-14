import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { TicketAutomationRule } from "./automation-contracts.js";

export interface TicketAutomationRepository {
  bootstrap(): Promise<void>;
  saveRule(rule: Omit<TicketAutomationRule, "id" | "enabled"> & { enabled?: boolean }): Promise<TicketAutomationRule>;
  listRules(ownerId: string, projectSlug: string): Promise<TicketAutomationRule[]>;
}

function rowJson<T>(row: Record<string, unknown>, key: string): T {
  const value = row[key];
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function automationId(): string {
  return `automation_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export class KyselyTicketAutomationRepository implements TicketAutomationRepository {
  constructor(
    private readonly db: Kysely<any>,
    private readonly maxRulesPerProject = 1_000,
  ) {}

  async bootstrap(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS ticket_automation_rules (
        id text PRIMARY KEY,
        owner_id text NOT NULL,
        project_slug text NOT NULL,
        enabled boolean NOT NULL,
        rule jsonb NOT NULL,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      )
    `.execute(this.db);
    await sql`
      CREATE INDEX IF NOT EXISTS idx_ticket_automation_rules_project
      ON ticket_automation_rules (owner_id, project_slug, created_at DESC)
    `.execute(this.db);
  }

  async saveRule(rule: Omit<TicketAutomationRule, "id" | "enabled"> & { enabled?: boolean }): Promise<TicketAutomationRule> {
    return await this.db.transaction().execute(async (trx) => {
      const countRow = await trx
        .selectFrom("ticket_automation_rules")
        .select(({ fn }) => fn.count<number>("id").as("count"))
        .where("owner_id", "=", rule.ownerId)
        .where("project_slug", "=", rule.projectSlug)
        .executeTakeFirst();
      if (Number(countRow?.count ?? 0) >= this.maxRulesPerProject) {
        const oldest = await trx
          .selectFrom("ticket_automation_rules")
          .select(["id"])
          .where("owner_id", "=", rule.ownerId)
          .where("project_slug", "=", rule.projectSlug)
          .orderBy("created_at", "asc")
          .limit(1)
          .executeTakeFirst() as Record<string, unknown> | undefined;
        if (typeof oldest?.id === "string") {
          await trx.deleteFrom("ticket_automation_rules").where("id", "=", oldest.id).execute();
        }
      }
      const automation: TicketAutomationRule = {
        ...rule,
        id: automationId(),
        enabled: rule.enabled ?? true,
      };
      await trx.insertInto("ticket_automation_rules").values({
        id: automation.id,
        owner_id: automation.ownerId,
        project_slug: automation.projectSlug,
        enabled: automation.enabled,
        rule: JSON.stringify(automation),
      }).execute();
      return automation;
    });
  }

  async listRules(ownerId: string, projectSlug: string): Promise<TicketAutomationRule[]> {
    const rows = await this.db
      .selectFrom("ticket_automation_rules")
      .select(["rule"])
      .where("owner_id", "=", ownerId)
      .where("project_slug", "=", projectSlug)
      .orderBy("created_at", "desc")
      .execute() as Array<Record<string, unknown>>;
    return rows.map((row) => rowJson<TicketAutomationRule>(row, "rule"));
  }
}

import { vi } from "vitest";
import type { ChatAgentClient } from "../../packages/ui/src/chat-agents/client.js";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";

export const saved = { id: "bot_meeting01", revision: 1, name: "Meeting helper", description: "Prepare meetings",
  instructions: "Summarize decisions.", selection: { instanceId: "hermes_default", model: "openai:gpt-5.6-sol" },
  archived: false, createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z" };
export const recipeCatalog = {
  enabled: true,
  skills: [
    { id: "matrix-integrations" as const, name: "Matrix integrations", description: "Use connected Matrix integrations." },
    { id: "matrix-personal-daily-brief" as const, name: "Personal Daily Brief", description: "Prepare a source-backed daily brief." },
  ],
  services: [
    { id: "gmail", name: "Gmail" },
    { id: "google_calendar", name: "Google Calendar" },
  ],
};
const connections = [
  { service: "gmail", account_label: "Work", account_email: "work@example.test", status: "active" },
  { service: "gmail", account_label: "Personal", account_email: "personal@example.test", status: "active" },
  { service: "google_calendar", account_label: "Calendar", account_email: "calendar@example.test", status: "active" },
];
export function clientFixture() {
  const catalog = createCanonicalProviderCatalogFixture();
  catalog.drivers.push({ ...catalog.drivers[0]!, kind: "hermes", displayName: "Hermes" });
  catalog.instances.push({ ...catalog.instances[0]!, id: "hermes_default", driverKind: "hermes",
    models: [{ ...catalog.instances[0]!.models[0]!, id: saved.selection.model }],
    defaultSelection: saved.selection,
  });
  const client = {
    list: vi.fn(async () => ({ enabled: true, agents: [] })),
    catalog: vi.fn(async () => catalog),
    recipeCatalog: vi.fn(async () => recipeCatalog),
    integrations: vi.fn(async () => connections),
    create: vi.fn(async (input) => ({ ...saved, name: input.name, description: input.description,
      instructions: input.instructions, selection: input.selection, ...(input.recipe ? { recipe: input.recipe } : {}) })),
    update: vi.fn(async (_id, input) => ({ ...saved, revision: 2,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      ...(input.selection === undefined ? {} : { selection: input.selection }),
      ...(input.recipe === undefined ? {} : input.recipe === null ? {} : { recipe: input.recipe }),
    })),
    search: vi.fn(async () => ({ enabled: true, resources: [] })), preview: vi.fn(),
  } satisfies ChatAgentClient;
  return client;
}

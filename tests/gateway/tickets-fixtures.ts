export type TicketFixtureSourceKind = "linear" | "matrix";
export type TicketFixtureStatus = "Todo" | "In Progress" | "Ready" | "Done";

export interface TicketFixture {
  id: string;
  projectSlug: string;
  identifier: string;
  sourceKind: TicketFixtureSourceKind;
  externalId: string | null;
  title: string;
  status: TicketFixtureStatus;
  priority: "low" | "medium" | "high" | "urgent";
  revision: number;
  labels: string[];
  assigneeIds: string[];
  updatedAt: string;
}

export function createTicketFixture(overrides: Partial<TicketFixture> = {}): TicketFixture {
  const sourceKind = overrides.sourceKind ?? "matrix";
  const externalId = overrides.externalId ?? (sourceKind === "linear" ? "LIN-123" : null);

  return {
    id: "ticket_123",
    projectSlug: "matrix-os",
    identifier: sourceKind === "linear" ? "LIN-123" : "MAT-123",
    sourceKind,
    externalId,
    title: "Build Matrix Desktop workbench",
    status: "Todo",
    priority: "medium",
    revision: 1,
    labels: ["desktop"],
    assigneeIds: [],
    updatedAt: "2026-05-14T18:00:00.000Z",
    ...overrides,
  };
}

export function createTicketPage(count: number, overrides: Partial<TicketFixture> = {}): TicketFixture[] {
  return Array.from({ length: count }, (_, index) =>
    createTicketFixture({
      ...overrides,
      id: `ticket_${index + 1}`,
      identifier: `${overrides.sourceKind === "linear" ? "LIN" : "MAT"}-${index + 1}`,
      externalId: overrides.sourceKind === "linear" ? `LIN-${index + 1}` : null,
      revision: index + 1,
    }),
  );
}

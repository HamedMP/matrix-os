import type { GetStartedRecipeBotId, GettingStartedRow, GettingStartedStepId } from "@matrix-os/contracts";

/** How a Getting started row reads; shared so every surface shows the same states. */
export interface GettingStartedRowView {
  label: string;
  done: boolean;
  struck: boolean;
  detail?: string;
  trailing: "icon" | "try" | "waiting";
}

const NONE: ReadonlySet<string> = new Set();

export function gettingStartedRowView(
  row: GettingStartedRow,
  connectingService: string | null,
  failedServices: ReadonlySet<string> = NONE,
): GettingStartedRowView {
  const done = row.status === "complete";
  if (done && row.kind !== "bot" && row.try) return { label: row.try.label, done, struck: false, trailing: "try" };
  if (row.kind !== "bot" && row.connect && row.connect === connectingService) {
    return { label: row.label, done, struck: false, detail: "Waiting for sign-in…", trailing: "waiting" };
  }
  if (row.kind !== "bot" && row.connect && failedServices.has(row.connect)) {
    return { label: row.label, done, struck: false, detail: "Sign-in didn't finish. Click to try again.", trailing: "icon" };
  }
  const detail = row.kind === "step" && row.detail ? { detail: row.detail } : {};
  return { label: row.label, done, struck: done, ...detail, trailing: "icon" };
}

/** What clicking a row does; each surface carries it out with its own navigation. */
export type GettingStartedRowAction =
  | { type: "try"; prompt: string }
  | { type: "connect"; service: string }
  | { type: "step"; id: GettingStartedStepId }
  | { type: "settings" }
  | { type: "bot"; recipeId: GetStartedRecipeBotId }
  /** A chosen bot that failed to create: create the saved bot choices again. */
  | { type: "create-bots" };

export function gettingStartedRowAction(row: GettingStartedRow, { canConnect }: { canConnect: boolean }): GettingStartedRowAction {
  if (row.kind === "bot") return row.create ? { type: "create-bots" } : { type: "bot", recipeId: row.recipeId };
  if (row.status === "complete" && row.try) return { type: "try", prompt: row.try.prompt };
  if (row.connect && canConnect) return { type: "connect", service: row.connect };
  return row.kind === "step" ? { type: "step", id: row.id } : { type: "settings" };
}

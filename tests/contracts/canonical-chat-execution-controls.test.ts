import { describe, expect, it } from "vitest";
import { canonicalChatExecutionControls, canonicalChatTurnModes } from "../../packages/contracts/src/index";
import { createCanonicalChatFixture } from "./fixtures/canonical-chat";

const fixture = createCanonicalChatFixture("completed");
const run = { ...fixture.snapshot.runs[0]!, interactionMode: "plan", permissionMode: "full_access" };
const context = { chatId: run.chatId, currentSelection: run.selection, runs: [run] };

describe("canonical Chat execution controls", () => {
  it("restores the accepted choice even when that run failed", () => {
    expect(canonicalChatExecutionControls({ ...context, runs: [{ ...run, status: "failed" }] }))
      .toMatchObject({ chatId: run.chatId, runId: run.id, interactionMode: "plan", permissionMode: "full_access" });
  });
  it("uses the latest accepted choice rather than resurrecting older full access", () => {
    const latest = { ...run, id: "run_latest", historyBoundarySeq: 5, permissionMode: "supervised" };
    expect(canonicalChatExecutionControls({ ...context, runs: [latest, run] })?.permissionMode).toBe("supervised");
  });
  it.each([
    { ...context, chatId: "chat_another" },
    { ...context, currentSelection: { ...run.selection, model: "another" } },
    { ...context, currentSelection: { ...run.selection, options: [{ id: "account", value: "another" }] } },
    { ...context, runs: [run, { ...run, id: "run_ambiguous", permissionMode: "supervised" }] },
    { ...context, runs: [run, { ...run, id: "run_other_model", historyBoundarySeq: 5, selection: { ...run.selection, model: "another" } }] },
  ])("does not carry controls across scopes, bindings, or ambiguous history", (input) => {
    expect(canonicalChatExecutionControls(input)).toBeUndefined();
  });
  it("validates restored choices against the current catalog", () => {
    const controls = canonicalChatExecutionControls(context);
    expect(canonicalChatTurnModes(fixture.providerCatalog, run.selection, controls))
      .toEqual({ interactionMode: "plan", permissionMode: "full_access" });
    const catalog = structuredClone(fixture.providerCatalog);
    catalog.instances[0]!.supports.permissionModes = ["supervised"];
    expect(canonicalChatTurnModes(catalog, run.selection, controls)?.permissionMode).toBe("supervised");
    expect(canonicalChatTurnModes(catalog, run.selection, { ...controls!, selection: { ...run.selection, model: "another" } })?.interactionMode).toBe("default");
  });
});

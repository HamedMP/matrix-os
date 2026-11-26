import type { CanonicalChatExecutionControls } from "@matrix-os/contracts";

import { permissionModeChoices } from "@/components/chat/permission-modes";
import { chosenTurnModes } from "@/lib/canonical-chat-selection";

import { GPT, SONNET, catalogOf, codexInstance, matrixInstance, type Instance } from "./model-test-catalog";

const ALL_MODES = ["supervised", "auto_accept_edits", "auto", "full_access"];

/** An engine that runs turns in the given modes, as the computer lists Claude Code and Codex with all four. */
function withModes(instance: Instance, permissionModes: string[], interactionModes = ["default", "plan"]): Instance {
  return { ...instance, supports: { ...instance.supports, permissionModes, interactionModes } };
}

const codex = (modes = ALL_MODES) => withModes(codexInstance(), modes);
const matrix = (modes = ["supervised"]) => withModes(matrixInstance(), modes);

describe("the permission modes offered for a selection", () => {
  it("are the engine's own, in its order, named as Desktop names them, with the current one marked", () => {
    expect(permissionModeChoices(catalogOf(codex()), GPT, "auto")).toEqual([
      { value: "supervised", label: "Ask for approval", selected: false },
      { value: "auto_accept_edits", label: "Auto Accept Edits", selected: false },
      { value: "auto", label: "Auto", selected: true },
      { value: "full_access", label: "Full Access", selected: false },
    ]);
  });

  it.each([
    ["the engine runs turns in one mode only", catalogOf(matrix(), codex()), SONNET],
    ["the selection's engine is not listed", catalogOf(codex()), SONNET],
    ["the selection cannot run", catalogOf(codex()), { ...GPT, model: "retired-model" }],
    ["there is no catalog yet", null, GPT],
    ["nothing is selected", catalogOf(codex()), null],
  ])("are none when %s", (_case, catalog, selection) => {
    expect(permissionModeChoices(catalog, selection, "supervised")).toEqual([]);
  });
});

describe("the modes a turn is sent with", () => {
  const ranWith = (permissionMode: string): CanonicalChatExecutionControls => ({
    chatId: "chat_a", runId: "run_a", selection: GPT, interactionMode: "plan", permissionMode,
  });

  it("take the permission mode asked for when the engine runs it, keeping the interaction mode", () => {
    expect(chosenTurnModes(catalogOf(codex()), GPT, ranWith("supervised"), "full_access"))
      .toEqual({ interactionMode: "plan", permissionMode: "full_access" });
  });

  it("keep the mode the chat last ran with when none is asked for", () => {
    expect(chosenTurnModes(catalogOf(codex()), GPT, ranWith("auto"), null))
      .toEqual({ interactionMode: "plan", permissionMode: "auto" });
  });

  it("start as Supervised when nothing is asked for and the chat has not run", () => {
    expect(chosenTurnModes(catalogOf(codex()), GPT, undefined, undefined))
      .toEqual({ interactionMode: "default", permissionMode: "supervised" });
  });

  it("fall back as Desktop does when the engine does not run the mode asked for", () => {
    expect(chosenTurnModes(catalogOf(matrix(), codex()), SONNET, undefined, "full_access"))
      .toEqual({ interactionMode: "default", permissionMode: "supervised" });
    expect(chosenTurnModes(catalogOf(codex(["auto", "full_access"])), GPT, undefined, "auto_accept_edits"))
      .toEqual({ interactionMode: "default", permissionMode: "auto" });
  });

  it("are none while the selection cannot be sent", () => {
    expect(chosenTurnModes(catalogOf(codex()), { ...GPT, model: "retired-model" }, undefined, "full_access")).toBeNull();
    expect(chosenTurnModes(null, GPT, undefined, "full_access")).toBeNull();
  });
});

import { createComposerChoiceStore } from "@/lib/remembered-composer-choice";
import { permissionModeChoices } from "@/components/chat/permission-modes";
import { catalogOf, codexInstance, engineInstance, GPT } from "./model-test-catalog";

const scope = "owner:computer:primary";
const claude = { instanceId: "claude_default", model: "claude-opus-5", options: [{ id: "effort", value: "max" }] };
const codex = { ...GPT, options: [{ id: "effort", value: "high" }] };

it("keeps provider effort and permission separate across switches and a storage reload", async () => {
  let raw: string | null = null;
  const storage = { getItem: async () => raw, setItem: async (_key: string, value: string) => { raw = value; } };
  const store = createComposerChoiceStore(storage);
  await store.load();
  store.remember(scope, { selection: codex, permissionMode: "auto_review" });
  store.remember(scope, { selection: claude, permissionMode: "auto" });
  // A model pick chooses a model explicitly but restores only that provider's access.
  store.remember(scope, { selection: { ...codex, model: "gpt-5.6-mini" } });
  expect(store.choice(scope)?.permissionMode).toBe("auto_review");
  await new Promise(resolve => setTimeout(resolve, 0));
  const restored = createComposerChoiceStore(storage);
  await restored.load();
  expect(restored.choice(scope, claude.instanceId)).toEqual({ selection: claude, permissionMode: "auto" });
  expect(restored.choice(scope, codex.instanceId)).toMatchObject({ selection: { model: "gpt-5.6-mini" }, permissionMode: "auto_review" });
  expect(restored.choice("other:computer:primary", codex.instanceId)).toBeNull();
});

it("does not copy a legacy provider's access to a first-use provider", async () => {
  const store = createComposerChoiceStore({
    getItem: async () => JSON.stringify({ entries: [{ scope, choice: { selection: codex, permissionMode: "full_access" } }] }),
    setItem: async () => undefined,
  });
  await store.load();
  expect(store.choice(scope, codex.instanceId)?.permissionMode).toBe("full_access");
  expect(store.choice(scope, claude.instanceId)).toBeNull();
  store.remember(scope, { selection: claude });
  expect(store.choice(scope)?.permissionMode).toBeUndefined();
});

it("names each provider's actual modes in the native model sheet", () => {
  const c = codexInstance();
  c.supports.permissionModes = ["supervised", "auto_review", "full_access"];
  const a = engineInstance(claude.instanceId, "claude_code", "Claude Code", [[claude.model, "Opus"]]);
  a.supports.permissionModes = ["supervised", "auto_accept_edits", "auto", "dont_ask", "full_access"];
  const catalog = catalogOf(c, a);
  expect(permissionModeChoices(catalog, codex, "auto_review").map(v => v.label))
    .toEqual(["Ask for approval", "Approve for me", "Full Access"]);
  expect(permissionModeChoices(catalog, claude, "dont_ask").map(v => v.label))
    .toEqual(["Manual", "Accept edits", "Auto", "Don't ask", "Full Access"]);
});

it("keeps other providers when a choice is made during storage hydration", async () => {
  let finish!: (value: string | null) => void;
  const store = createComposerChoiceStore({
    getItem: () => new Promise(resolve => { finish = resolve; }),
    setItem: async () => undefined,
  });
  const loading = store.load();
  store.remember(scope, { selection: codex, permissionMode: "auto_review" });
  finish(JSON.stringify({ entries: [{ scope, choice: { selection: claude, permissionMode: "auto" } }] }));
  await loading;
  expect(store.choice(scope, claude.instanceId)).toEqual({ selection: claude, permissionMode: "auto" });
  expect(store.choice(scope, codex.instanceId)?.permissionMode).toBe("auto_review");
});

it("bounds provider rows while keeping the most recently changed provider", async () => {
  const store = createComposerChoiceStore({ getItem: async () => null, setItem: async () => undefined });
  await store.load();
  for (let index = 0; index < 21; index += 1) {
    store.remember(scope, { selection: { instanceId: `codex_${index}`, model: GPT.model }, permissionMode: "supervised" });
  }
  expect(store.choice(scope, "codex_0")).toBeNull();
  expect(store.choice(scope, "codex_20")?.selection?.instanceId).toBe("codex_20");
});

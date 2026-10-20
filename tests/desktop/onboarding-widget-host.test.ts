import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../desktop/src/shared/app-error";
import { createLegacyGlobalProviderCatalog } from "../../desktop/src/renderer/src/features/chat/canonical-composer-adapter";
import {
  DEFAULT_ONBOARDING_PREFS,
  onboardingActiveAi,
  onboardingAiForInstance,
  onboardingLoginPresentation,
  onboardingPrefsKey,
  onboardingSessionInit,
  readOnboardingPrefs,
  writeOnboardingPrefs,
} from "@matrix-os/ui";
import {
  admitOnboardingTurn,
  isComputerStartingError,
  loadOnboardingRepos,
  onboardingApps,
  onboardingConnectedProviders,
  onboardingCreditsExhausted,
  onboardingSelection,
  pickProviderConnectionOption,
  relativeUpdatedLabel,
} from "../../desktop/src/renderer/src/features/onboarding-widget/onboarding-widget-runner";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

function catalogWith(patch: (instance: CanonicalProviderCatalog["instances"][number]) => CanonicalProviderCatalog["instances"][number]): CanonicalProviderCatalog {
  const base = createLegacyGlobalProviderCatalog({ hasProject: false });
  return { ...base, instances: base.instances.map(patch) };
}

describe("onboarding widget prefs", () => {
  it("scopes the key to the owner and runtime slot", () => {
    expect(onboardingPrefsKey("sahar", "primary")).toBe("matrix:onboarding-widget:v1:sahar:primary");
    expect(onboardingPrefsKey("a:b", "x/y")).toBe("matrix:onboarding-widget:v1:a%3Ab:x%2Fy");
  });

  it("keeps two signed-in accounts apart when they share a browser", () => {
    expect(onboardingPrefsKey("owner", "primary", "user_a")).toBe("matrix:onboarding-widget:v1:user_a:owner:primary");
    expect(onboardingPrefsKey("owner", "primary", "user_a")).not.toBe(onboardingPrefsKey("owner", "primary", "user_b"));
    expect(onboardingPrefsKey("a:b", "primary", "x:y")).toBe("matrix:onboarding-widget:v1:x%3Ay:a%3Ab:primary");
  });

  it("round-trips valid prefs and returns null for anything unusable", () => {
    const storage = memoryStorage({ junk: "{not json", wrong: JSON.stringify({ keepInCorner: "yes" }), huge: "x".repeat(3000) });
    writeOnboardingPrefs("k", { ...DEFAULT_ONBOARDING_PREFS, chatId: "chat_1" }, storage);
    expect(readOnboardingPrefs("k", storage)).toEqual({ ...DEFAULT_ONBOARDING_PREFS, chatId: "chat_1" });
    expect(readOnboardingPrefs("missing", storage)).toBeNull();
    expect(readOnboardingPrefs("junk", storage)).toBeNull();
    expect(readOnboardingPrefs("wrong", storage)).toBeNull();
    expect(readOnboardingPrefs("huge", storage)).toBeNull();
  });

  it("remembers where the widget was moved", () => {
    const storage = memoryStorage();
    const moved = { ...DEFAULT_ONBOARDING_PREFS, position: { x: "left", y: "top", dx: 320, dy: 140 } } as const;
    writeOnboardingPrefs("k", moved, storage);
    expect(readOnboardingPrefs("k", storage)).toEqual(moved);
  });

  it("reads prefs saved with the old left or right side as that bottom corner", () => {
    const legacy = { keepInCorner: false, side: "left", showOnLogin: true, firstTaskCompleted: true, aiChoice: "claude", chatId: "chat_9" };
    const storage = memoryStorage({ legacy: JSON.stringify(legacy), bad: JSON.stringify({ ...legacy, side: "top" }) });
    expect(readOnboardingPrefs("legacy", storage)).toEqual({
      keepInCorner: false,
      position: { x: "left", y: "bottom", dx: 24, dy: 24 },
      showOnLogin: true,
      firstTaskCompleted: true,
      aiChoice: "claude",
      chatId: "chat_9",
      pendingRun: null,
    });
    expect(readOnboardingPrefs("bad", storage)).toBeNull();
  });

  it("rejects a saved position that is not whole, bounded pixel offsets", () => {
    const at = (position: unknown) => JSON.stringify({ ...DEFAULT_ONBOARDING_PREFS, position });
    const storage = memoryStorage({
      negative: at({ x: "left", y: "top", dx: -5, dy: 10 }),
      huge: at({ x: "left", y: "top", dx: 1e9, dy: 10 }),
      fractional: at({ x: "left", y: "top", dx: 1.5, dy: 10 }),
      sideways: at({ x: "middle", y: "top", dx: 10, dy: 10 }),
    });
    for (const key of ["negative", "huge", "fractional", "sideways"]) expect(readOnboardingPrefs(key, storage)).toBeNull();
  });

  it("returns null when storage itself throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readOnboardingPrefs("k", { getItem: () => { throw new DOMException("denied", "SecurityError"); } })).toBeNull();
    warn.mockRestore();
  });

  it("auto-opens in the corner until the first task is done, then Show on every login decides", () => {
    expect(onboardingLoginPresentation({ ...DEFAULT_ONBOARDING_PREFS, keepInCorner: false, showOnLogin: false })).toBe("corner");
    const done = { ...DEFAULT_ONBOARDING_PREFS, firstTaskCompleted: true };
    expect(onboardingLoginPresentation(done)).toBe("corner");
    expect(onboardingLoginPresentation({ ...done, showOnLogin: false })).toBe("bubble");
    expect(onboardingLoginPresentation({ ...done, showOnLogin: false, keepInCorner: true })).toBe("bubble");
  });

  const pendingRun = { taskId: "research", answer: "Trip ideas for Lisbon", appConnected: true, simpler: false, runId: "run_1" } as const;

  it("still saves a follow-up whose title is a long research topic, shortened", () => {
    const storage = memoryStorage();
    const topic = "AI agent pricing ".repeat(100).trim();
    writeOnboardingPrefs("k", { ...DEFAULT_ONBOARDING_PREFS, chatId: "chat_1", pendingRun: { ...pendingRun, taskId: "custom", answer: "Go deeper", title: topic } }, storage);
    const saved = readOnboardingPrefs("k", storage)?.pendingRun;
    expect(saved).toMatchObject({ taskId: "custom", runId: "run_1" });
    expect(saved?.title?.length).toBeLessThanOrEqual(200);
    expect(saved?.title?.endsWith("…")).toBe(true);
    expect(topic.startsWith(saved!.title!.slice(0, -1))).toBe(true);
  });

  it("keeps a pending run across restarts and still reads prefs saved before it existed", () => {
    const storage = memoryStorage();
    writeOnboardingPrefs("k", { ...DEFAULT_ONBOARDING_PREFS, chatId: "chat_1", pendingRun: { ...pendingRun, answer: "x".repeat(2_000) } }, storage);
    expect(readOnboardingPrefs("k", storage)?.pendingRun).toMatchObject({ taskId: "research", runId: "run_1" });
    const { pendingRun: _omitted, ...legacy } = DEFAULT_ONBOARDING_PREFS;
    const old = memoryStorage({ k: JSON.stringify({ ...legacy, firstTaskCompleted: true }) });
    expect(readOnboardingPrefs("k", old)).toEqual({ ...DEFAULT_ONBOARDING_PREFS, firstTaskCompleted: true });
    const bad = memoryStorage({ k: JSON.stringify({ ...DEFAULT_ONBOARDING_PREFS, pendingRun: { ...pendingRun, taskId: "rm -rf" } }) });
    expect(readOnboardingPrefs("k", bad)).toBeNull();
  });

  it("starts the session from stored prefs, reopening a pending run", () => {
    expect(onboardingSessionInit({ ...DEFAULT_ONBOARDING_PREFS, chatId: "chat_1", pendingRun })).toEqual({
      size: "corner", firstTaskCompleted: false, aiChoice: "matrix", chatId: "chat_1", pendingRun,
    });
    expect(onboardingSessionInit({ ...DEFAULT_ONBOARDING_PREFS, firstTaskCompleted: true, showOnLogin: false }).size).toBe("bubble");
  });
});

describe("onboarding AI selection", () => {
  it("uses Hermes for Matrix AI and the matching harness for Claude or ChatGPT", () => {
    const legacy = createLegacyGlobalProviderCatalog({ hasProject: false });
    expect(onboardingSelection(legacy, "matrix")?.instanceId).toBe("hermes_default");
    expect(onboardingSelection(legacy, "codex")).toBeNull();
    expect(onboardingConnectedProviders(legacy)).toEqual([]);

    const codexReady = catalogWith((instance) => instance.driverKind === "codex" ? { ...instance, availability: "available" } : instance);
    expect(onboardingConnectedProviders(codexReady)).toEqual(["codex"]);
  });

  function harness(id: string, driverKind: string, availability: "available" | "unavailable" = "available") {
    const hermes = createLegacyGlobalProviderCatalog({ hasProject: false }).instances.find((instance) => instance.id === "hermes_default")!;
    return { ...hermes, id, driverKind, availability, defaultSelection: { instanceId: id, model: "provider-default" } } as CanonicalProviderCatalog["instances"][number];
  }
  const catalogOf = (...instances: CanonicalProviderCatalog["instances"]): CanonicalProviderCatalog =>
    ({ ...createLegacyGlobalProviderCatalog({ hasProject: false }), instances });
  const hermesOff = harness("hermes_default", "hermes", "unavailable");
  const claude = harness("claude_code_default", "claude_code");

  it("names the AI a chat's provider instance belongs to, or nothing for one the widget does not offer", () => {
    const catalog = catalogOf(hermesOff, claude, harness("codex_default", "codex"), harness("pi_default", "pi"));
    expect(onboardingAiForInstance(catalog, "hermes_default")).toBe("matrix");
    expect(onboardingAiForInstance(catalog, "matrix_pi_default")).toBe("matrix");
    expect(onboardingAiForInstance(catalog, "claude_code_default")).toBe("claude");
    expect(onboardingAiForInstance(catalog, "codex_default")).toBe("codex");
    expect(onboardingAiForInstance(catalog, "pi_default")).toBeNull();
    expect(onboardingAiForInstance(catalog, "gone_instance")).toBeNull();
  });

  it("runs Matrix AI only on Hermes or the managed Matrix route, never on whatever else is the default", () => {
    expect(onboardingSelection(catalogOf(hermesOff, claude), "matrix")).toBeNull();
    expect(onboardingSelection(catalogOf(hermesOff, harness("matrix_pi_default", "matrix_pi"), claude), "matrix")?.instanceId).toBe("matrix_pi_default");
    expect(onboardingSelection(catalogOf(hermesOff, claude), "claude")?.instanceId).toBe("claude_code_default");
    expect(onboardingSelection(catalogOf(hermesOff, harness("claude_code_default", "claude_code", "unavailable")), "claude")).toBeNull();
  });

  it("names the AI a task really runs on, and keeps the saved choice for when Matrix AI can run again", () => {
    expect(onboardingActiveAi(catalogOf(hermesOff, claude), "matrix")).toBe("claude");
    expect(onboardingActiveAi(catalogOf(hermesOff), "matrix")).toBe("matrix");
    expect(onboardingActiveAi(createLegacyGlobalProviderCatalog({ hasProject: false }), "matrix")).toBe("matrix");
    expect(onboardingActiveAi(catalogOf(hermesOff, claude), "codex")).toBe("codex");
  });

  it("reports exhausted credits only for the selected instance", () => {
    const exhausted = catalogWith((instance) => instance.id === "hermes_default" ? { ...instance, connectionState: "credit_required" } : instance);
    const selection = onboardingSelection(createLegacyGlobalProviderCatalog({ hasProject: false }), "matrix");
    expect(onboardingCreditsExhausted(exhausted, selection)).toBe(true);
    expect(onboardingCreditsExhausted(createLegacyGlobalProviderCatalog({ hasProject: false }), selection)).toBe(false);
    expect(onboardingCreditsExhausted(exhausted, null)).toBe(false);
  });

  const option = (id: string, providerId: "anthropic" | "openai" | "openrouter", authKind: "subscription" | "api_key", extra: Record<string, unknown> = {}) =>
    ({ id, providerId, authKind, availability: "available" as const, ...extra });

  it("picks the vendor's own key option, never another provider's", () => {
    const rows = [
      { harnessInstanceId: "h_claude", harness: "claude", connectionOptions: [
        option("openrouter_api_key", "openrouter", "api_key"),
        option("anthropic_api_key", "anthropic", "api_key"),
      ] },
      { harnessInstanceId: "h_codex", harness: "codex", connectionOptions: [option("openai_api_key", "openai", "api_key")] },
    ];
    expect(pickProviderConnectionOption(rows, "claude", "api_key")).toEqual({ harnessInstanceId: "h_claude", optionId: "anthropic_api_key" });
    expect(pickProviderConnectionOption(rows, "codex", "api_key")).toEqual({ harnessInstanceId: "h_codex", optionId: "openai_api_key" });
  });

  it("only picks account sign-ins the widget can finish", () => {
    const claude = { harnessInstanceId: "h_claude", harness: "claude", connectionOptions: [
      option("anthropic_terminal", "anthropic", "subscription", { method: "terminal" }),
      option("anthropic_browser", "anthropic", "subscription", { method: "browser" }),
    ] };
    expect(pickProviderConnectionOption([claude], "claude", "account", { codeEntry: true }))
      .toEqual({ harnessInstanceId: "h_claude", optionId: "anthropic_browser", method: "browser" });
    expect(pickProviderConnectionOption([claude], "claude", "account", { codeEntry: false })).toBeNull();
    const withDevice = { ...claude, connectionOptions: [...claude.connectionOptions, option("anthropic_device", "anthropic", "subscription", { method: "device_code" })] };
    expect(pickProviderConnectionOption([withDevice], "claude", "account", { codeEntry: true })?.method).toBe("device_code");
  });

  it("has nothing to offer when the harness is missing, unavailable or key-only", () => {
    const rows = [
      { harnessInstanceId: "h_legacy", harness: "claude" },
      { harnessInstanceId: "h_codex", harness: "codex", connectionOptions: [
        option("openai_api_key", "openai", "api_key", { availability: "unavailable", unavailableReason: "not_installed" }),
      ] },
    ];
    expect(pickProviderConnectionOption(rows, "claude", "account", { codeEntry: true })).toBeNull();
    expect(pickProviderConnectionOption(rows, "codex", "account", { codeEntry: true })).toBeNull();
    expect(pickProviderConnectionOption(rows, "codex", "api_key")).toBeNull();
  });
});

describe("onboarding apps and repos", () => {
  it("maps integrations to widget apps with status and category", () => {
    const apps = onboardingApps(
      [{ id: "github", name: "GitHub" }, { id: "gmail", name: "Gmail", logoUrl: "https://x/g.png" }, { id: "notion", name: "Notion" }] as never,
      [{ id: "c1", service: "gmail", status: "active" }] as never,
      "github",
    );
    expect(apps).toEqual([
      { id: "github", name: "GitHub", category: "dev", status: "connecting" },
      { id: "gmail", name: "Gmail", logoUrl: "https://x/g.png", category: "personal", status: "connected" },
      { id: "notion", name: "Notion", category: "work", status: "available" },
    ]);
  });

  it("offers Connect again for an expired connection", () => {
    const apps = onboardingApps(
      [{ id: "github", name: "GitHub" }, { id: "gmail", name: "Gmail" }] as never,
      [{ id: "c1", service: "github", status: "expired" }, { id: "c2", service: "gmail", status: "active" }] as never,
      null,
    );
    expect(apps.map((app) => app.status)).toEqual(["available", "connected"]);
  });

  it("caps the app list", () => {
    const many = Array.from({ length: 80 }, (_, index) => ({ id: `s${index}`, name: `S${index}` }));
    expect(onboardingApps(many as never, [], null)).toHaveLength(50);
  });

  it("labels repo recency", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    expect(relativeUpdatedLabel("2026-10-09T11:58:00Z", now)).toBe("2m ago");
    expect(relativeUpdatedLabel("2026-10-09T09:00:00Z", now)).toBe("3h ago");
    expect(relativeUpdatedLabel("2026-10-08T10:00:00Z", now)).toBe("Yesterday");
    expect(relativeUpdatedLabel("2026-10-01T12:00:00Z", now)).toBe("8d ago");
    expect(relativeUpdatedLabel("nope", now)).toBeUndefined();
    expect(relativeUpdatedLabel(null, now)).toBeUndefined();
  });

  const github = { id: "conn_1", accountLabel: "sahar" };

  it("lists repos through the connected GitHub app, most recent first", async () => {
    const post = vi.fn().mockResolvedValue({ data: [
      { name: "site", full_name: "sahar/site", html_url: "https://github.com/sahar/site", pushed_at: null, updated_at: null },
      { name: "x", full_name: "evil/x", html_url: "javascript:alert(1)" },
    ] });
    const get = vi.fn();
    const repos = await loadOnboardingRepos({ get, post } as never, github, new AbortController().signal);
    expect(repos).toEqual([{ name: "site", url: "https://github.com/sahar/site" }]);
    expect(post).toHaveBeenCalledWith("/api/integrations/read-call", {
      service: "github", action: "list_repos", label: "sahar", connectionId: "conn_1", params: { sort: "updated", per_page: 20 },
    }, expect.objectContaining({ timeoutMs: 10_000 }));
    expect(get).not.toHaveBeenCalled();
  });

  it("falls back to the computer's GitHub CLI when the app read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const post = vi.fn().mockRejectedValue(new AppError("server"));
    const get = vi.fn().mockResolvedValue({ repos: [
      { nameWithOwner: "sahar/site", url: "https://github.com/sahar/site", updatedAt: null },
      { nameWithOwner: "evil/x", url: "javascript:alert(1)" },
    ] });
    await expect(loadOnboardingRepos({ get, post } as never, github, new AbortController().signal))
      .resolves.toEqual([{ name: "site", url: "https://github.com/sahar/site" }]);
    expect(get).toHaveBeenCalledWith("/api/github/repos?limit=20", expect.objectContaining({ timeoutMs: 10_000 }));
    await expect(loadOnboardingRepos({ get: vi.fn().mockResolvedValue({ nope: true }), post } as never, null, new AbortController().signal)).resolves.toEqual([]);
    warn.mockRestore();
  });
});

describe("onboarding turn admission", () => {
  const selection = { instanceId: "hermes_default", model: "default", options: [], interactionMode: "default", permissionMode: "default" };
  const admitted = (chatId: string) => ({ record: { chat: { id: chatId } }, run: { id: "run_1" } });
  const requestIds = { create: "req_create_1", turn: "req_turn_1" };

  it("creates a new chat named after the task", async () => {
    const client = {
      create: vi.fn().mockResolvedValue({ chat: { id: "chat_new", revision: 3 } }),
      getDetail: vi.fn(),
      admitTurn: vi.fn().mockResolvedValue(admitted("chat_new")),
    };
    await expect(admitOnboardingTurn({ client: client as never, chatId: null, title: "Research: AI agent pricing", prompt: "Do it", selection, requestIds }))
      .resolves.toEqual({ chatId: "chat_new", runId: "run_1" });
    expect(client.getDetail).not.toHaveBeenCalled();
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({ title: "Research: AI agent pricing", clientRequestId: "req_create_1" }));
    expect(client.admitTurn).toHaveBeenCalledWith("chat_new", expect.objectContaining({
      clientRequestId: "req_turn_1", baseRevision: 3, parts: [{ type: "text", text: "Do it" }], selection: { instanceId: "hermes_default", model: "default" },
    }), { chatScope: "global" });
  });

  it("sends a retry or follow-up into the task's chat at its current revision", async () => {
    const client = {
      create: vi.fn(),
      getDetail: vi.fn().mockResolvedValue({ record: { chat: { revision: 9 } } }),
      admitTurn: vi.fn().mockResolvedValue(admitted("chat_old")),
    };
    await admitOnboardingTurn({ client: client as never, chatId: "chat_old", title: "Week plan", prompt: "Again", selection, requestIds });
    expect(client.create).not.toHaveBeenCalled();
    expect(client.admitTurn).toHaveBeenCalledWith("chat_old", expect.objectContaining({ baseRevision: 9 }), { chatScope: "global" });
  });

  // The widget would now pick Hermes with full access; the chat ran on Claude, supervised.
  const fullAccess = { ...selection, permissionMode: "full_access" };
  const claude = { instanceId: "claude_default", model: "claude-sonnet", options: [{ id: "effort", value: "high" }] };
  const run = (id: string, createdAt: string, permissionMode: string) => ({
    id, instanceId: "claude_default", selection: claude, interactionMode: "default", permissionMode, createdAt,
  });
  const boundDetail = (runs: unknown[]) => ({
    record: { chat: { revision: 4, currentSelection: claude }, providerBinding: { instanceId: "claude_default" } },
    runs,
  });

  it("keeps a follow-up on the AI and permission mode its chat last ran with, even after the widget's choice changes", async () => {
    const client = {
      create: vi.fn(),
      getDetail: vi.fn().mockResolvedValue(boundDetail([
        run("run_old", "2026-10-19T10:00:00.000Z", "auto_accept_edits"),
        run("run_last", "2026-10-19T11:00:00.000Z", "supervised"),
      ])),
      admitTurn: vi.fn().mockResolvedValue(admitted("chat_old")),
    };
    await admitOnboardingTurn({ client: client as never, chatId: "chat_old", title: "Research: AI agent pricing", prompt: "Follow up", selection: fullAccess, requestIds });
    expect(client.create).not.toHaveBeenCalled();
    expect(client.admitTurn).toHaveBeenCalledWith("chat_old", expect.objectContaining({
      baseRevision: 4, selection: claude, interactionMode: "default", permissionMode: "supervised",
    }), { chatScope: "global" });
  });

  it("starts a new chat instead of guessing permissions for a bound chat that never ran", async () => {
    const client = {
      create: vi.fn().mockResolvedValue({ chat: { id: "chat_new", revision: 1 } }),
      getDetail: vi.fn().mockResolvedValue(boundDetail([])),
      admitTurn: vi.fn().mockResolvedValue(admitted("chat_new")),
    };
    await admitOnboardingTurn({ client: client as never, chatId: "chat_old", title: "Research: AI agent pricing", prompt: "Try again", selection, requestIds });
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({ clientRequestId: "req_create_1", currentSelection: { instanceId: "hermes_default", model: "default" } }));
    expect(client.admitTurn).toHaveBeenCalledWith("chat_new", expect.objectContaining({ selection: { instanceId: "hermes_default", model: "default" }, permissionMode: "default" }), { chatScope: "global" });
  });

  it("uses the widget's choice for a chat that is not bound yet", async () => {
    const client = {
      create: vi.fn(),
      getDetail: vi.fn().mockResolvedValue({ record: { chat: { revision: 5, currentSelection: claude } }, runs: [] }),
      admitTurn: vi.fn().mockResolvedValue(admitted("chat_old")),
    };
    await admitOnboardingTurn({ client: client as never, chatId: "chat_old", title: "Research: AI agent pricing", prompt: "Unbound", selection, requestIds });
    expect(client.admitTurn).toHaveBeenLastCalledWith("chat_old", expect.objectContaining({ selection: { instanceId: "hermes_default", model: "default" }, permissionMode: "default" }), { chatScope: "global" });
  });

  it("starts a new chat when the remembered one is gone, but surfaces other failures", async () => {
    const client = {
      create: vi.fn().mockResolvedValue({ chat: { id: "chat_new", revision: 1 } }),
      getDetail: vi.fn().mockRejectedValue(new AppError("notFound")),
      admitTurn: vi.fn().mockResolvedValue(admitted("chat_new")),
    };
    await expect(admitOnboardingTurn({ client: client as never, chatId: "chat_gone", title: "Week plan", prompt: "x", selection, requestIds }))
      .resolves.toEqual({ chatId: "chat_new", runId: "run_1" });
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({ title: "Week plan" }));
    client.getDetail.mockRejectedValue(new AppError("offline"));
    await expect(admitOnboardingTurn({ client: client as never, chatId: "chat_gone", title: "Week plan", prompt: "x", selection, requestIds })).rejects.toThrow(AppError);
  });

  it("treats only offline and timeout as the computer still starting", () => {
    expect(isComputerStartingError(new AppError("offline"))).toBe(true);
    expect(isComputerStartingError(new AppError("timeout"))).toBe(true);
    expect(isComputerStartingError(new AppError("server"))).toBe(false);
    expect(isComputerStartingError(new Error("offline"))).toBe(false);
  });
});

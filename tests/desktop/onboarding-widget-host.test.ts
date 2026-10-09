import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../desktop/src/shared/app-error";
import { createLegacyGlobalProviderCatalog } from "../../desktop/src/renderer/src/features/chat/canonical-composer-adapter";
import {
  DEFAULT_ONBOARDING_PREFS,
  onboardingLoginPresentation,
  onboardingPrefsKey,
  readOnboardingPrefs,
  writeOnboardingPrefs,
} from "../../desktop/src/renderer/src/features/onboarding-widget/onboarding-widget-prefs";
import {
  admitOnboardingTurn,
  isComputerStartingError,
  loadOnboardingRepos,
  ONBOARDING_CHAT_TITLE,
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

  it("round-trips valid prefs and returns null for anything unusable", () => {
    const storage = memoryStorage({ junk: "{not json", wrong: JSON.stringify({ keepInCorner: "yes" }), huge: "x".repeat(3000) });
    writeOnboardingPrefs("k", { ...DEFAULT_ONBOARDING_PREFS, chatId: "chat_1" }, storage);
    expect(readOnboardingPrefs("k", storage)).toEqual({ ...DEFAULT_ONBOARDING_PREFS, chatId: "chat_1" });
    expect(readOnboardingPrefs("missing", storage)).toBeNull();
    expect(readOnboardingPrefs("junk", storage)).toBeNull();
    expect(readOnboardingPrefs("wrong", storage)).toBeNull();
    expect(readOnboardingPrefs("huge", storage)).toBeNull();
  });

  it("returns null when storage itself throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readOnboardingPrefs("k", { getItem: () => { throw new DOMException("denied", "SecurityError"); } })).toBeNull();
    warn.mockRestore();
  });

  it("auto-opens in the corner until the first task is done, then follows the menu choices", () => {
    expect(onboardingLoginPresentation({ ...DEFAULT_ONBOARDING_PREFS, keepInCorner: false, showOnLogin: false })).toBe("corner");
    const done = { ...DEFAULT_ONBOARDING_PREFS, firstTaskCompleted: true };
    expect(onboardingLoginPresentation(done)).toBe("bubble");
    expect(onboardingLoginPresentation({ ...done, keepInCorner: true })).toBe("corner");
    expect(onboardingLoginPresentation({ ...done, showOnLogin: false })).toBe("hidden");
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

  it("creates the Getting started chat on the first task", async () => {
    const client = {
      create: vi.fn().mockResolvedValue({ chat: { id: "chat_new", revision: 3 } }),
      getDetail: vi.fn(),
      admitTurn: vi.fn().mockResolvedValue(admitted("chat_new")),
    };
    await expect(admitOnboardingTurn({ client: client as never, chatId: null, prompt: "Do it", selection })).resolves.toEqual({ chatId: "chat_new", runId: "run_1" });
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({ title: ONBOARDING_CHAT_TITLE }));
    expect(client.admitTurn).toHaveBeenCalledWith("chat_new", expect.objectContaining({
      baseRevision: 3, parts: [{ type: "text", text: "Do it" }], selection: { instanceId: "hermes_default", model: "default" },
    }), { chatScope: "global" });
  });

  it("reuses the existing chat at its current revision", async () => {
    const client = {
      create: vi.fn(),
      getDetail: vi.fn().mockResolvedValue({ record: { chat: { revision: 9 } } }),
      admitTurn: vi.fn().mockResolvedValue(admitted("chat_old")),
    };
    await admitOnboardingTurn({ client: client as never, chatId: "chat_old", prompt: "Again", selection });
    expect(client.create).not.toHaveBeenCalled();
    expect(client.admitTurn).toHaveBeenCalledWith("chat_old", expect.objectContaining({ baseRevision: 9 }), { chatScope: "global" });
  });

  it("starts a new chat when the remembered one is gone, but surfaces other failures", async () => {
    const client = {
      create: vi.fn().mockResolvedValue({ chat: { id: "chat_new", revision: 1 } }),
      getDetail: vi.fn().mockRejectedValue(new AppError("notFound")),
      admitTurn: vi.fn().mockResolvedValue(admitted("chat_new")),
    };
    await expect(admitOnboardingTurn({ client: client as never, chatId: "chat_gone", prompt: "x", selection })).resolves.toEqual({ chatId: "chat_new", runId: "run_1" });
    client.getDetail.mockRejectedValue(new AppError("offline"));
    await expect(admitOnboardingTurn({ client: client as never, chatId: "chat_gone", prompt: "x", selection })).rejects.toThrow(AppError);
  });

  it("treats only offline and timeout as the computer still starting", () => {
    expect(isComputerStartingError(new AppError("offline"))).toBe(true);
    expect(isComputerStartingError(new AppError("timeout"))).toBe(true);
    expect(isComputerStartingError(new AppError("server"))).toBe(false);
    expect(isComputerStartingError(new Error("offline"))).toBe(false);
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";

import { AgentAccessSections, type AgentAccessSectionsProps } from "../components/agents/AgentAccessSections";
import { createCanonicalProviderCatalogFixture } from "../../../tests/contracts/fixtures/canonical-chat";

import { flat } from "./ui-test-utils";

const selected = { instanceId: "matrix_pi_default", model: "cloudflare:@cf/zai-org/glm-5.3-flash" };
const automatic = { instanceId: "matrix_bot_default", model: "auto" };
const catalog = createCanonicalProviderCatalogFixture();
const baseInstance = catalog.instances[0]!;
catalog.instances = [{ ...baseInstance, id: selected.instanceId, driverKind: "matrix_pi", displayName: "Pi", connectionLabel: "Matrix AI",
  models: [{ ...baseInstance.models[0]!, id: selected.model, displayName: "GLM 5.3 Flash" }] }];

const authority = {
  agentId: "bot_research1",
  revision: 1,
  grants: [{ grantId: "gr_abcdefgh", service: "gmail", accountLabel: "Work", effects: ["read", "send"], audience: "direct", expiresAt: null }],
  connections: [{ service: "gmail", state: "granted" }],
  routines: [],
  pendingInteractions: [],
  memory: { items: [
    { itemId: "mem_abcdefgh", kind: "preference", scope: "bot", content: "Keep briefs concise",
      source: { at: "2026-09-28T12:00:00.000Z" }, confirmed: false, revision: 1 },
    { itemId: "mem_confirmed", kind: "fact", scope: "bot", content: "Fiscal year ends in June",
      source: { at: "2026-09-20T12:00:00.000Z" }, confirmed: true, revision: 4 },
  ] },
};

const tasks = [{ taskId: "task_abcdefgh", chatId: "chat_research", agentId: "bot_research1",
  status: "waiting_person", revision: 1, updatedAt: "2026-09-28T12:00:00.000Z" }];

function renderSections(overrides: Partial<AgentAccessSectionsProps> = {}) {
  const props = {
    authority,
    tasks,
    actionsAvailable: true,
    onRevoke: jest.fn(async () => undefined),
    onMemory: jest.fn(async () => undefined),
    onRefresh: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as AgentAccessSectionsProps;
  return { props, ...render(<AgentAccessSections {...props} />) };
}

const section = (name: string) => screen.getByTestId(`agent-details-${name}`);

describe("agent details: tasks, permissions, memory and model", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    warn.mockRestore();
  });

  it("puts each under its own label, in the Apps card's style", () => {
    renderSections({ selection: automatic, catalog, onSelectModel: jest.fn() } as never);

    expect(screen.getAllByRole("header").map((header) => header.props.children)).toEqual([
      "Tasks", "Permissions", "Memory", "Model",
    ]);
    for (const name of ["tasks", "permissions", "memory", "model"]) {
      expect(flat(section(name))).toMatchObject({
        backgroundColor: "#FAF9F7", borderRadius: 14, paddingTop: 10, paddingHorizontal: 14, paddingBottom: 4,
      });
    }
  });

  it("draws nothing for an agent whose access could not be read and that has no task", () => {
    renderSections({ authority: null, tasks: [] });

    expect(screen.queryByRole("header")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("leaves out each section that has nothing in it", () => {
    renderSections({ authority: { ...authority, grants: [], memory: { items: [] } } as never, tasks: [] });

    expect(screen.queryByRole("header")).toBeNull();
  });

  describe("tasks", () => {
    it("says what each unfinished task is doing, in the words every surface shares", () => {
      renderSections({ tasks: [...tasks, { ...tasks[0], taskId: "task_blocked", status: "blocked", blockedReason: "funds_unavailable" }] as never });

      expect(within(section("tasks")).getByText("Waiting for your answer")).toBeTruthy();
      expect(within(section("tasks")).getByText("Funds unavailable")).toBeTruthy();
    });
  });

  describe("permissions", () => {
    it("lists each grant by service and account, with what it allows", () => {
      renderSections();

      const permissions = section("permissions");
      expect(flat(within(permissions).getByText("Gmail · Work"))).toMatchObject({ fontSize: 15, lineHeight: 22, color: "#242323" });
      expect(flat(within(permissions).getByText("Read, send"))).toMatchObject({ fontSize: 13, lineHeight: 18, color: "#635F5F" });
    });

    it("words narrow access the way every surface does, with what stays untouched", () => {
      renderSections({ authority: { ...authority, grants: [{ ...authority.grants[0]!, effects: ["read", "label"] }] } } as never);

      const permissions = section("permissions");
      expect(within(permissions).getByText("Read Inbox, add Jev classification labels")).toBeTruthy();
      expect(flat(within(permissions).getByText("Preserve existing labels; no archive, send, delete, or mark read.")))
        .toMatchObject({ fontSize: 13, lineHeight: 18, color: "#635F5F" });
    });

    it("revokes a grant, then has the agent's status read again", async () => {
      const { props } = renderSections();

      const revoke = screen.getByRole("button", { name: "Revoke Work" });
      expect(flat(revoke)).toMatchObject({ height: 44, borderWidth: 1, borderColor: "#E5E5E5" });
      fireEvent.press(revoke);

      await waitFor(() => expect(props.onRevoke).toHaveBeenCalledWith("gr_abcdefgh"));
      await waitFor(() => expect(props.onRefresh).toHaveBeenCalledTimes(1));
    });

    it("holds every other control while a grant is being revoked", async () => {
      let finish: () => void = () => {};
      const onRevoke = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
      const { props } = renderSections({ onRevoke });

      fireEvent.press(screen.getByRole("button", { name: "Revoke Work" }));

      await waitFor(() => (
        expect(screen.getByRole("button", { name: "Revoke Work" }).props.accessibilityState).toMatchObject({ busy: true })
      ));
      const forget = screen.getAllByRole("button", { name: "Forget memory" })[0];
      expect(forget.props.accessibilityState).toMatchObject({ disabled: true, busy: false });
      fireEvent.press(forget);
      expect(props.onMemory).not.toHaveBeenCalled();

      await act(async () => finish());
      expect(screen.getAllByRole("button", { name: "Forget memory" })[0].props.accessibilityState).toMatchObject({ disabled: false });
    });

    it("says in generic words, under the grants, that access could not be changed", async () => {
      const onRevoke = jest.fn(async () => { throw new Error("upstream said no"); });
      const { props } = renderSections({ onRevoke });

      fireEvent.press(screen.getByRole("button", { name: "Revoke Work" }));

      const failure = await within(section("permissions")).findByRole("alert");
      expect(failure.props.children).toBe("Could not change the agent's access. Try again.");
      expect(flat(failure).color).toBe("#BA5236");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("upstream said no");
      expect(props.onRefresh).not.toHaveBeenCalled();
      // The grant is still listed: nothing changes until the server confirms.
      expect(screen.getByRole("button", { name: "Revoke Work" }).props.accessibilityState).toMatchObject({ disabled: false });
    });

    it("says so when the change was saved but the status could not be read again", async () => {
      const onRefresh = jest.fn(async () => { throw new Error("status down"); });
      renderSections({ onRefresh });

      fireEvent.press(screen.getByRole("button", { name: "Revoke Work" }));

      const failure = await within(section("permissions")).findByRole("alert");
      expect(failure.props.children).toBe("Agent status could not be loaded. Try again.");
    });

    it("shows the cached grants read-only while the agent's status is out of date", () => {
      const { props } = renderSections({ actionsAvailable: false });

      const revoke = screen.getByRole("button", { name: "Revoke Work" });
      expect(revoke.props.accessibilityState.disabled).toBe(true);
      fireEvent.press(revoke);
      expect(props.onRevoke).not.toHaveBeenCalled();
    });
  });

  describe("memory", () => {
    it("lists what the agent remembers and when it learned it", () => {
      renderSections();

      const memory = section("memory");
      expect(within(memory).getByText("Keep briefs concise")).toBeTruthy();
      expect(within(memory).getByText("Fiscal year ends in June")).toBeTruthy();
      expect(within(memory).getAllByText(/^From chat · /)).toHaveLength(2);
    });

    it("confirms a memory at its revision, and offers that only for an unconfirmed one", async () => {
      const { props } = renderSections();
      expect(screen.getAllByRole("button", { name: "Confirm memory" })).toHaveLength(1);

      fireEvent.press(screen.getByRole("button", { name: "Confirm memory" }));

      await waitFor(() => expect(props.onMemory).toHaveBeenCalledWith("mem_abcdefgh", "confirm", { baseRevision: 1 }));
      await waitFor(() => expect(props.onRefresh).toHaveBeenCalledTimes(1));
    });

    it("forgets a memory at its revision", async () => {
      const { props } = renderSections();

      fireEvent.press(screen.getAllByRole("button", { name: "Forget memory" })[1]);

      await waitFor(() => expect(props.onMemory).toHaveBeenCalledWith("mem_confirmed", "forget", { baseRevision: 4 }));
    });

    it("shows the request on the pressed button only", async () => {
      let finish: () => void = () => {};
      const onMemory = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
      renderSections({ onMemory });

      fireEvent.press(screen.getAllByRole("button", { name: "Forget memory" })[0]);

      await waitFor(() => (
        expect(screen.getAllByRole("button", { name: "Forget memory" })[0].props.accessibilityState).toMatchObject({ busy: true })
      ));
      expect(screen.getByRole("button", { name: "Confirm memory" }).props.accessibilityState).toMatchObject({ busy: false, disabled: true });
      await act(async () => finish());
    });

    it("says in generic words, under the memories, that it could not be changed", async () => {
      const onMemory = jest.fn(async () => { throw new Error("upstream said no"); });
      renderSections({ onMemory });

      fireEvent.press(screen.getByRole("button", { name: "Confirm memory" }));

      const failure = await within(section("memory")).findByRole("alert");
      expect(failure.props.children).toBe("Could not change the agent's access. Try again.");
    });
  });

  describe("model", () => {
    it("reads the saved model and shows when the computer no longer offers it", () => {
      renderSections({ selection: selected, catalog: { ...catalog, instances: [] } } as never);

      expect(within(section("model")).getByText(`Matrix AI · ${selected.model} · unavailable`)).toBeTruthy();
    });

    it("changes only the model, through the action given for it", async () => {
      const save = jest.fn(async () => undefined);
      const { props } = renderSections({ selection: automatic, catalog, onSelectModel: save } as never);

      fireEvent.press(screen.getByRole("button", { name: "GLM 5.3 Flash · Matrix AI" }));

      await waitFor(() => expect(save).toHaveBeenCalledWith(selected));
      await waitFor(() => expect(props.onRefresh).toHaveBeenCalled());
    });

    it("goes back to the model this computer manages", async () => {
      const save = jest.fn(async () => undefined);
      renderSections({ selection: selected, catalog, onSelectModel: save } as never);

      fireEvent.press(screen.getByRole("button", { name: "Automatic · managed by this computer" }));

      await waitFor(() => expect(save).toHaveBeenCalledWith(automatic));
    });

    it("shows a model that cannot be chosen as text, not as an action", () => {
      const held = { ...catalog, instances: [{ ...catalog.instances[0]!, availability: "unavailable" as const, connectionState: "credit_reserved" as const,
        defaultSelection: undefined, models: catalog.instances[0]!.models.map((model) => ({ ...model, availability: "unavailable" as const })) }] };
      const save = jest.fn();
      renderSections({ selection: selected, catalog: held, onSelectModel: save } as never);

      const row = screen.getByText("GLM 5.3 Flash · Matrix AI · Credit reserved");
      expect(row.props.accessibilityState).toMatchObject({ disabled: true });
      expect(row.props.onPress).toBeUndefined();
      fireEvent.press(row);
      expect(save).not.toHaveBeenCalled();
      expect(screen.getByText("Matrix AI · GLM 5.3 Flash · credit reserved")).toBeTruthy();
    });

    it.each([
      [selected, "Matrix AI · GLM 5.3 Flash"],
      [automatic, "Model routing: automatic"],
    ])("words the saved model as every surface does, without runtime details: %j", (selection, label) => {
      renderSections({ selection, catalog } as never);

      expect(within(section("model")).getByText(label)).toBeTruthy();
      expect(screen.queryByText(/Runtime: Pi/)).toBeNull();
      // Without an action to change it, the choices are not offered.
      expect(within(section("model")).queryByRole("button")).toBeNull();
    });

    it("has no model section until the agent's model is known", () => {
      renderSections({ catalog, onSelectModel: jest.fn() } as never);

      expect(screen.queryByTestId("agent-details-model")).toBeNull();
      expect(screen.queryByText(/Checking/)).toBeNull();
    });

    it("says in generic words that the model could not be saved", async () => {
      const save = jest.fn(async () => { throw new Error("upstream said no"); });
      renderSections({ selection: automatic, catalog, onSelectModel: save } as never);

      fireEvent.press(screen.getByRole("button", { name: "GLM 5.3 Flash · Matrix AI" }));

      const failure = await within(section("model")).findByRole("alert");
      expect(failure.props.children).toBe("Model could not be saved. Try again.");
    });

    it("holds the choices while the agent's status is out of date", () => {
      const save = jest.fn();
      renderSections({ selection: automatic, catalog, onSelectModel: save, actionsAvailable: false } as never);

      const choice = screen.getByRole("button", { name: "GLM 5.3 Flash · Matrix AI" });
      expect(choice.props.accessibilityState).toMatchObject({ disabled: true });
      fireEvent.press(choice);
      expect(save).not.toHaveBeenCalled();
    });
  });
});

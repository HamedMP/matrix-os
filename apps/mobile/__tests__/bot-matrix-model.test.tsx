import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { BotChatControls } from "@/components/BotChatControls";
import { createCanonicalProviderCatalogFixture } from "../../../tests/contracts/fixtures/canonical-chat";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

beforeEach(() => jest.useFakeTimers());
afterEach(() => { act(() => jest.runOnlyPendingTimers()); cleanup(); jest.useRealTimers(); });

const selected = { instanceId: "matrix_pi_default", model: "cloudflare:@cf/zai-org/glm-5.3-flash" };
const catalog = createCanonicalProviderCatalogFixture();
const base = catalog.instances[0]!;
catalog.instances = [{ ...base, id: selected.instanceId, driverKind: "matrix_pi", displayName: "Pi", connectionLabel: "Matrix AI",
  models: [{ ...base.models[0]!, id: selected.model, displayName: "GLM 5.3 Flash" }] }];

it("reads saved Matrix model intent in Native Mobile bot controls and shows unavailable state", () => {
  const snapshot = { agentId: "bot_abcdefgh", name: "Writer", selection: selected, interactions: [], tasks: [],
    authority: { agentId: "bot_abcdefgh", revision: 1, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } } };
  render(<BotChatControls snapshot={snapshot} catalog={{ ...catalog, instances: [] }}
    onResolve={jest.fn()} onRevoke={jest.fn()} onMemory={jest.fn()} onRefresh={jest.fn()} />);
  expect(screen.getByText(`Model: Matrix AI · ${selected.model} · unavailable`)).toBeTruthy();
});

it("edits only the bot model through its revisioned Native Mobile action", async () => {
  const save = jest.fn(async () => undefined);
  const refresh = jest.fn();
  const snapshot = { agentId: "bot_abcdefgh", name: "Writer", revision: 2, selection: { instanceId: "matrix_bot_default", model: "auto" }, interactions: [], tasks: [],
    authority: { agentId: "bot_abcdefgh", revision: 1, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } } };
  render(<BotChatControls snapshot={snapshot} catalog={catalog} onSelectionChange={save}
    onResolve={jest.fn()} onRevoke={jest.fn()} onMemory={jest.fn()} onRefresh={refresh} />);
  fireEvent.press(screen.getByText("GLM 5.3 Flash · Matrix AI"));
  await waitFor(() => expect(save).toHaveBeenCalledWith(selected));
  expect(refresh).toHaveBeenCalled();
});
it("shows disabled discovery in Native Mobile bot controls without a model-save action", () => {
  const held = { ...catalog, instances: [{ ...catalog.instances[0]!, availability: "unavailable" as const, connectionState: "credit_reserved" as const,
    defaultSelection: undefined, models: catalog.instances[0]!.models.map(model => ({ ...model, availability: "unavailable" as const })) }] };
  const save = jest.fn();
  const snapshot = { agentId: "bot_abcdefgh", name: "Writer", revision: 2, selection: selected, interactions: [], tasks: [],
    authority: { agentId: "bot_abcdefgh", revision: 1, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } } };
  render(<BotChatControls snapshot={snapshot} catalog={held} onSelectionChange={save}
    onResolve={jest.fn()} onRevoke={jest.fn()} onMemory={jest.fn()} onRefresh={jest.fn()} />);
  const row = screen.getByText("GLM 5.3 Flash · Matrix AI · Credit reserved");
  expect(row.props.accessibilityState).toMatchObject({ disabled: true });
  expect(row.props.onPress).toBeUndefined();
  fireEvent.press(row);
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByText("Model: Matrix AI · GLM 5.3 Flash · credit reserved")).toBeTruthy();
});

it.each([
  [selected, "Model: Matrix AI · GLM 5.3 Flash"],
  [{ instanceId: "matrix_bot_default", model: "auto" }, "Model: Model routing: automatic"],
  [undefined, "Model: Checking bot model…"],
])("preserves the Native Mobile bot model state without runtime details: %s", (selection, label) => {
  const snapshot = { agentId: "bot_abcdefgh", name: "Writer", selection, interactions: [], tasks: [],
    authority: { agentId: "bot_abcdefgh", revision: 1, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } } };
  render(<BotChatControls snapshot={snapshot} catalog={catalog}
    onResolve={jest.fn()} onRevoke={jest.fn()} onMemory={jest.fn()} onRefresh={jest.fn()} />);
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.queryByText(/Runtime: Pi/)).toBeNull();
});

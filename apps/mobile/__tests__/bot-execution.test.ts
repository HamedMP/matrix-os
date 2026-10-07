import { act, renderHook } from "@testing-library/react-native";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import { createCanonicalProviderCatalogFixture } from "../../../tests/contracts/fixtures/canonical-chat";
import { useNativeBotExecution } from "../lib/bot-execution";
import type { NativeBotChatSnapshot } from "../lib/requests/bots";

const bot: NativeBotChatSnapshot = {
  kind: "custom", agentId: "bot_custom01", name: "Saved custom Bot", revision: 2,
  selection: { instanceId: "saved_harness", model: "retained" }, interactions: [], tasks: [], authority: null,
};
function catalog(permissionModes: string[]): CanonicalProviderCatalog {
  const result = createCanonicalProviderCatalogFixture(), base = result.instances[0]!;
  result.instances = [{ ...base, id: "saved_harness", driverKind: "opencode", models: [{ ...base.models[0]!, id: "retained" }],
    supports: { ...base.supports, permissionModes } }];
  return result;
}

type Props = { snapshot: NativeBotChatSnapshot; catalog: CanonicalProviderCatalog | null; scope: string; request: string };
function setup(overrides: Partial<Props> = {}) {
  const props: Props = { snapshot: bot, catalog: catalog(["supervised", "full_access"]), scope: "owner:runtime:chat_one", request: "Read only", ...overrides };
  return { props, ...renderHook((value: Props) => useNativeBotExecution(value.snapshot, value.catalog, value.scope, value.request), { initialProps: props }) };
}

it("ignores old or requested Full access when the current catalog only supports Supervised", () => {
  const { result, rerender, props } = setup();
  act(() => result.current.confirm(true));
  expect(result.current.permissionMode).toBe("full_access");
  rerender({ ...props, catalog: catalog(["supervised"]) });
  expect(result.current.supportsFullAccess).toBe(false);
  expect(result.current.confirmed).toBe(false);
  expect(result.current.permissionMode).toBe("supervised");
  act(() => result.current.confirm(true));
  expect(result.current.confirmed).toBe(false);
  expect(result.current.permissionMode).toBe("supervised");
  rerender(props);
  expect(result.current.confirmed).toBe(false);
  expect(result.current.permissionMode).toBe("supervised");
});

const consentChanges: Array<[string, Partial<Props>]> = [
  ["owner or runtime or Chat", {scope: "other_owner:other_runtime:chat_two"}],
  ["Bot revision", {snapshot: {...bot, revision: 3}}],
  ["draft request", {request: "A different request"}],
  ["saved model options", {snapshot: {...bot, selection: {...bot.selection!, options: [{id:"effort",value:"high"}]}}}],
];

it.each(consentChanges)("does not transfer confirmed Full access after changing the %s", (_label, changed) => {
  const { result, rerender, props } = setup();
  act(() => result.current.confirm(true));
  expect(result.current.confirmed).toBe(true);
  rerender({...props, ...changed});
  expect(result.current.confirmed).toBe(false);
  expect(result.current.permissionMode).toBe("supervised");
  rerender(props);
  expect(result.current.confirmed).toBe(false);
});

it("clears consent while the catalog is unavailable and does not restore it on reconnect", () => {
  const { result, rerender, props } = setup();
  act(() => result.current.confirm(true));
  rerender({...props, catalog: null});
  expect(result.current.supportsFullAccess).toBe(false);
  expect(result.current.confirmed).toBe(false);
  expect(result.current.permissionMode).not.toBe("full_access");
  rerender(props);
  expect(result.current.confirmed).toBe(false);
});

it("full-only custom harnesses require fresh confirmation after an accepted request", () => {
  const {result} = setup({catalog: catalog(["full_access"])});
  expect(result.current.presentation?.requiresFullAccess).toBe(true);
  expect(result.current.permissionMode).toBe("default");
  act(()=>result.current.confirm(true));
  expect(result.current.permissionMode).toBe("full_access");
  act(()=>result.current.reset());
  expect(result.current.confirmed).toBe(false);
  expect(result.current.permissionMode).toBe("default");
});

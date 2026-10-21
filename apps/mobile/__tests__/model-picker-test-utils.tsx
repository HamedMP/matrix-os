import { fireEvent, render, screen, within } from "@testing-library/react-native";
import type { CanonicalChatModelSelection, CanonicalProviderCatalog } from "@matrix-os/contracts";

import { ModelPicker } from "@/components/ModelPicker";

import { SONNET } from "./model-test-catalog";

export const OPUS = { instanceId: SONNET.instanceId, model: "anthropic:claude-opus-5" };

/** Renders the picker and returns the spy that receives its selection changes. */
export function renderPicker(
  catalog: CanonicalProviderCatalog | null,
  selection: CanonicalChatModelSelection | null,
  props: { catalogLoading?: boolean } = {},
) {
  const change = jest.fn();
  render(<ModelPicker catalog={catalog} selection={selection} onSelectionChange={change} {...props} />);
  return change;
}

export const trigger = () => screen.getByRole("button", { name: "Model" });
/** What the trigger shows as chosen. */
export const triggerValue = (): string => trigger().props.accessibilityValue.text;
export const openSheet = () => fireEvent.press(trigger());
export const engines = () => within(screen.getByTestId("model-sheet-engines"));
export const models = () => within(screen.getByTestId("model-sheet-models"));
export const modelNames = () => models().getAllByRole("button").map((node) => node.props.accessibilityLabel);

import { render, screen, within } from "@testing-library/react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { ModelSheet, type ModelSheetProps } from "../components/chat/ModelSheet";
import { MATRIX_ENGINE_ID, type ModelChoice, type ModelEngine } from "../components/chat/model-choices";
import type { ModelOptionGroup } from "../components/chat/model-options";

import { flat } from "./ui-test-utils";

function model(key: string, name: string, overrides: Partial<ModelChoice> = {}): ModelChoice {
  return { key, name, detail: "Matrix AI", logo: "matrix", selected: false, available: true, ...overrides };
}

export const matrix: ModelEngine = {
  id: MATRIX_ENGINE_ID,
  label: "Matrix AI",
  logo: "matrix",
  note: null,
  models: [
    model("m::sonnet", "Claude Sonnet 5", { selected: true }),
    model("m::glm", "GLM"),
    model("m::gf1", "GF1", { detail: "Matrix AI · Model unavailable", available: false }),
  ],
};
export const claude: ModelEngine = {
  id: "claude_code_default",
  label: "Claude Code",
  logo: "claude",
  note: null,
  models: [model("c::opus", "Opus 5", { detail: "Claude Code", logo: "claude" })],
};
export const codex: ModelEngine = {
  id: "codex_default",
  label: "Codex",
  logo: "codex",
  note: "Authentication required",
  models: [],
};

export const reasoning: ModelOptionGroup = {
  id: "effort",
  label: "Reasoning",
  values: [
    { value: "low", label: "Low", selected: false },
    { value: "medium", label: "Medium", selected: true },
  ],
};

/** Renders the sheet's content over a 34pt home indicator and returns the props it was given. */
export function renderSheet(overrides: Partial<ModelSheetProps> = {}) {
  const props: ModelSheetProps = {
    engines: [matrix, claude, codex],
    options: [],
    credit: null,
    onSelectModel: jest.fn(),
    onSelectOption: jest.fn(),
    ...overrides,
  };
  render(
    <SafeAreaInsetsContext.Provider value={{ top: 62, right: 0, bottom: 34, left: 0 }}>
      <ModelSheet {...props} />
    </SafeAreaInsetsContext.Provider>,
  );
  return props;
}

/** The style of a scroll view's content, which holds the gap between its children. */
export const contentStyle = (scroll: { props: { contentContainerStyle?: unknown } }) => (
  flat({ props: { style: scroll.props.contentContainerStyle } })
);
export const chip = (name: string | RegExp) => within(screen.getByTestId("model-sheet-engines")).getByRole("button", { name });
export const row = (name: string | RegExp) => within(screen.getByTestId("model-sheet-models")).getByRole("button", { name });
export const rowNames = () => within(screen.getByTestId("model-sheet-models")).getAllByRole("button")
  .map((node) => node.props.accessibilityLabel);

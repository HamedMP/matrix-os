import { cleanup, fireEvent, screen, within } from "@testing-library/react-native";
import { ScrollView } from "react-native";

import type { ModelEngine } from "../components/chat/model-choices";
import type { ModelOptionGroup } from "../components/chat/model-options";

import { matrix, renderSheet } from "./model-sheet-test-utils";

// Every scroll view under test shares this one spy, so a call is told apart
// by the row it was made on.
const scrollTo = ScrollView.prototype.scrollTo as unknown as jest.Mock;

function scrollsOf(rowTestID: string) {
  return scrollTo.mock.calls
    .filter((_call, index) => (scrollTo.mock.contexts[index] as ScrollView).props.testID === rowTestID)
    .map(([target]) => target);
}

const ENGINES = "model-sheet-engines";
const REASONING = "model-sheet-option-effort";
const ROW_WIDTH = 362;

function layout(x: number, width: number) {
  return { nativeEvent: { layout: { x, y: 0, width, height: 44 } } };
}

/** Reports the row's width, as the first layout does. */
function measureRow(rowTestID: string, width = ROW_WIDTH) {
  fireEvent(screen.getByTestId(rowTestID), "layout", layout(0, width));
}

/** Reports where each chip sits in the row's content, as [start, width]. */
function measureChips(rowTestID: string, frames: Record<string, [number, number]>) {
  const row = within(screen.getByTestId(rowTestID));
  for (const [name, [x, width]] of Object.entries(frames)) {
    fireEvent(row.getByRole("button", { name }), "layout", layout(x, width));
  }
}

const engineChip = (name: string) => within(screen.getByTestId(ENGINES)).getByRole("button", { name });

function engine(id: string, label: string, selected = false): ModelEngine {
  return {
    id,
    label,
    logo: "matrix",
    note: null,
    models: [{ key: `${id}::model`, name: `${label} model`, detail: label, logo: "matrix", selected, available: true }],
  };
}

// Four chips, 8pt apart, 442pt in all: the last ends 80pt past a 362pt row.
const CHIPS: Record<string, [number, number]> = {
  "Matrix AI": [0, 105],
  Hermes: [113, 100],
  OpenClaw: [221, 115],
  Codex: [344, 98],
};
const withCodexSelected = () => [engine("matrix-ai", "Matrix AI"), engine("hermes", "Hermes"), engine("openclaw", "OpenClaw"), engine("codex", "Codex", true)];
const withMatrixSelected = () => [engine("matrix-ai", "Matrix AI", true), engine("hermes", "Hermes"), engine("openclaw", "OpenClaw"), engine("codex", "Codex")];

describe("the engine row of the model sheet", () => {
  beforeEach(() => scrollTo.mockClear());
  afterEach(cleanup);

  it("brings the selection's chip fully into view when the sheet opens, without animating", () => {
    renderSheet({ engines: withCodexSelected() });

    measureRow(ENGINES);
    measureChips(ENGINES, CHIPS);

    expect(scrollsOf(ENGINES)).toEqual([{ x: 344 + 98 - ROW_WIDTH, animated: false }]);
  });

  it("does so whichever is measured first, the chips or the row", () => {
    renderSheet({ engines: withCodexSelected() });

    measureChips(ENGINES, CHIPS);
    expect(scrollsOf(ENGINES)).toEqual([]);
    measureRow(ENGINES);

    expect(scrollsOf(ENGINES)).toEqual([{ x: 80, animated: false }]);
  });

  it("leaves the row where it is when the chip already fits", () => {
    renderSheet({ engines: withMatrixSelected() });

    measureRow(ENGINES);
    measureChips(ENGINES, CHIPS);

    expect(scrollsOf(ENGINES)).toEqual([]);
  });

  it("does not move again when the row is measured again", () => {
    renderSheet({ engines: withCodexSelected() });
    measureRow(ENGINES);
    measureChips(ENGINES, CHIPS);

    measureRow(ENGINES);
    measureChips(ENGINES, CHIPS);

    expect(scrollsOf(ENGINES)).toHaveLength(1);
  });

  it("glides to a chip cut off at the end when its engine is shown", () => {
    renderSheet({ engines: withMatrixSelected() });
    measureRow(ENGINES);
    measureChips(ENGINES, CHIPS);

    fireEvent.press(engineChip("Codex"));

    expect(scrollsOf(ENGINES)).toEqual([{ x: 80, animated: true }]);
  });

  it("glides back to a chip cut off at the start", () => {
    renderSheet({ engines: withCodexSelected() });
    measureRow(ENGINES);
    measureChips(ENGINES, CHIPS);
    scrollTo.mockClear();

    // The row now starts 80pt in, which cuts Matrix AI off at its left.
    fireEvent.press(engineChip("Matrix AI"));

    expect(scrollsOf(ENGINES)).toEqual([{ x: 0, animated: true }]);
  });

  it("follows the person's own scrolling when deciding whether a chip is in view", () => {
    renderSheet({ engines: withMatrixSelected() });
    measureRow(ENGINES);
    measureChips(ENGINES, CHIPS);

    fireEvent.scroll(screen.getByTestId(ENGINES), { nativeEvent: { contentOffset: { x: 80, y: 0 } } });
    fireEvent.press(engineChip("Codex"));
    expect(scrollsOf(ENGINES)).toEqual([]);

    fireEvent.press(engineChip("Hermes"));
    expect(scrollsOf(ENGINES)).toEqual([]);

    fireEvent.scroll(screen.getByTestId(ENGINES), { nativeEvent: { contentOffset: { x: 150, y: 0 } } });
    fireEvent.press(engineChip("OpenClaw"));
    expect(scrollsOf(ENGINES)).toEqual([]);
    fireEvent.press(engineChip("Hermes"));
    expect(scrollsOf(ENGINES)).toEqual([{ x: 113, animated: true }]);
  });

  it("reports its scrolling often enough to keep track of it", () => {
    renderSheet({ engines: withMatrixSelected() });

    expect(screen.getByTestId(ENGINES).props.scrollEventThrottle).toBe(16);
  });

  it("shows the start of a chip that is wider than the row", () => {
    renderSheet({ engines: withCodexSelected() });

    measureRow(ENGINES, 80);
    measureChips(ENGINES, CHIPS);

    expect(scrollsOf(ENGINES)).toEqual([{ x: 344, animated: false }]);
  });
});

describe("the option row of the model sheet", () => {
  const efforts = ["Low", "Medium", "High", "Extra high", "Max", "Ultra"];
  const reasoning = (current: string): ModelOptionGroup => ({
    id: "effort",
    label: "Reasoning",
    values: efforts.map((label) => ({ value: label.toLowerCase(), label, selected: label === current })),
  });
  // Six chips: the last two start past a 362pt row.
  const VALUES: Record<string, [number, number]> = {
    Low: [0, 52],
    Medium: [60, 76],
    High: [144, 56],
    "Extra high": [208, 92],
    Max: [308, 54],
    Ultra: [370, 60],
  };

  beforeEach(() => scrollTo.mockClear());
  afterEach(cleanup);

  it("brings the current value into view when the sheet opens with it off the end", () => {
    renderSheet({ engines: [matrix], options: [reasoning("Ultra")] });

    measureRow(REASONING);
    measureChips(REASONING, VALUES);

    expect(scrollsOf(REASONING)).toEqual([{ x: 370 + 60 - ROW_WIDTH, animated: false }]);
    expect(scrollsOf(ENGINES)).toEqual([]);
  });

  it("stays put when the current value fits, and when none is marked", () => {
    renderSheet({ engines: [matrix], options: [reasoning("Medium")] });
    measureRow(REASONING);
    measureChips(REASONING, VALUES);
    expect(scrollsOf(REASONING)).toEqual([]);
    cleanup();

    renderSheet({ engines: [matrix], options: [reasoning("none of them")] });
    measureRow(REASONING);
    measureChips(REASONING, VALUES);
    expect(scrollsOf(REASONING)).toEqual([]);
  });
});

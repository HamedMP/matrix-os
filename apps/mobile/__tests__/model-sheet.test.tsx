import { cleanup, fireEvent, screen, within } from "@testing-library/react-native";

import { Icon } from "../components/ui/Icon";
import { CheckIcon } from "../components/ui/icons";
import { ProviderLogo } from "../components/ui/ProviderLogo";

import { chip, claude, codex, contentStyle, renderSheet, row, rowNames } from "./model-sheet-test-utils";
import { flat, pressedStyle } from "./ui-test-utils";

describe("model sheet", () => {
  afterEach(cleanup);

  it("pads the sheet 20pt at the sides and 10pt past the home indicator, with 14pt between blocks", () => {
    renderSheet();

    const body = flat(screen.getByTestId("model-sheet"));
    expect(body).toMatchObject({ paddingHorizontal: 20, paddingBottom: 34 + 10, gap: 14 });
    expect(body.paddingTop).toBeUndefined();
  });

  it("starts with the grabber, 10pt from the top, then the title in the 17pt headline", () => {
    renderSheet();

    const first = screen.getByTestId("model-sheet").children[0];
    expect(typeof first === "string" ? first : first.props.testID).toBe("model-sheet-grabber");
    expect(flat(screen.getByTestId("model-sheet-grabber"))).toMatchObject({ width: 36, height: 5, marginTop: 10 });
    expect(flat(screen.getByRole("header", { name: "Choose model" }))).toMatchObject({
      fontFamily: "Geist_600SemiBold",
      fontSize: 17,
      lineHeight: 25,
      color: "#242323",
    });
  });

  it("labels the engines Run with and the models Model", () => {
    renderSheet();

    expect(screen.getByRole("header", { name: "Run with" })).toBeTruthy();
    expect(screen.getByRole("header", { name: "Model" })).toBeTruthy();
  });

  it("draws one chip per engine, in order, 8pt apart in a row that scrolls sideways", () => {
    renderSheet();

    const engines = screen.getByTestId("model-sheet-engines");
    expect(engines.props.horizontal).toBe(true);
    expect(engines.props.showsHorizontalScrollIndicator).toBe(false);
    expect(contentStyle(engines).gap).toBe(8);
    expect(within(engines).getAllByRole("button").map((node) => node.props.accessibilityLabel))
      .toEqual(["Matrix AI", "Claude Code", "Codex, Authentication required"]);
  });

  it("leaves the chips their 44pt tap target without moving the blocks around them", () => {
    renderSheet();

    const engines = screen.getByTestId("model-sheet-engines");
    expect(flat(engines)).toMatchObject({ flexGrow: 0, marginVertical: -4 });
    expect(contentStyle(engines).paddingVertical).toBe(4);
    expect(36 + 2 * (chip("Matrix AI").props.hitSlop as number)).toBe(44);
  });

  it("selects the chip of the selection's engine and gives each an 18pt logo, white on the selected one", () => {
    renderSheet();

    expect(chip("Matrix AI").props.accessibilityState).toMatchObject({ selected: true });
    expect(chip("Claude Code").props.accessibilityState).toMatchObject({ selected: false });
    expect(within(chip("Matrix AI")).UNSAFE_getByType(ProviderLogo).props)
      .toMatchObject({ provider: "matrix", size: 18, color: "#FFFFFF" });
    const claudeLogo = within(chip("Claude Code")).UNSAFE_getByType(ProviderLogo).props;
    expect(claudeLogo).toMatchObject({ provider: "claude", size: 18 });
    expect(claudeLogo.color).toBeUndefined();
  });

  it("lists the shown engine's models 2pt apart", () => {
    renderSheet();

    expect(rowNames()).toEqual([
      "Claude Sonnet 5, Matrix AI",
      "GLM, Matrix AI",
      "GF1, Matrix AI · Model unavailable",
    ]);
    const models = screen.getByTestId("model-sheet-models");
    expect(contentStyle(models).gap).toBe(2);
  });

  it("draws a row 65pt high: 12pt padding around a 16pt medium name and a 12pt subtle second line", () => {
    renderSheet();

    const style = flat(row(/^GLM/));
    expect(style).toMatchObject({ flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 12 });
    const name = screen.getByText("GLM");
    expect(name.props.numberOfLines).toBe(1);
    expect(flat(name)).toMatchObject({ fontFamily: "Geist_500Medium", fontSize: 16, lineHeight: 22, color: "#242323" });
    const detail = within(row(/^GLM/)).getByText("Matrix AI");
    expect(detail.props.numberOfLines).toBe(1);
    expect(flat(detail)).toMatchObject({ fontFamily: "Geist_400Regular", fontSize: 12, lineHeight: 17, color: "#635F5F" });
    const line = flat(within(row(/^GLM/)).getByTestId("model-row-detail"));
    expect(line).toMatchObject({ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 });
    expect(2 * (style.padding as number) + 22 + (line.marginTop as number) + 17).toBe(65);
  });

  it("leads the second line with the engine's logo, as tall as the text", () => {
    renderSheet();

    expect(within(row(/^GLM/)).UNSAFE_getByType(ProviderLogo).props).toMatchObject({ provider: "matrix", size: 12 });
  });

  it("fills the selected row and ends it with an 18pt check; the others have neither", () => {
    renderSheet();

    const selected = row(/^Claude Sonnet 5/);
    expect(flat(selected).backgroundColor).toBe("#FAF9F7");
    expect(selected.props.accessibilityState).toMatchObject({ selected: true, disabled: false });
    expect(within(selected).UNSAFE_getByType(Icon).props).toMatchObject({ icon: CheckIcon, size: 18, color: "#242323" });

    const other = row(/^GLM/);
    expect(flat(other).backgroundColor).toBeUndefined();
    expect(other.props.accessibilityState).toMatchObject({ selected: false, disabled: false });
    expect(within(other).UNSAFE_queryByType(Icon)).toBeNull();
  });

  it("reports the model that is tapped, and dims a row while it is held", () => {
    const { onSelectModel } = renderSheet();

    fireEvent.press(row(/^GLM/));
    expect(onSelectModel).toHaveBeenCalledWith("m::glm");
    fireEvent.press(row(/^Claude Sonnet 5/));
    expect(onSelectModel).toHaveBeenLastCalledWith("m::sonnet");
    expect(pressedStyle({ accessibilityLabel: "GLM, Matrix AI" }).opacity).toBe(0.65);
  });

  it("keeps a model that cannot run in view, dimmed, saying why, and ignores a tap on it", () => {
    const { onSelectModel } = renderSheet();

    const blocked = row("GF1, Matrix AI · Model unavailable");
    expect(within(blocked).getByText("Matrix AI · Model unavailable")).toBeTruthy();
    expect(blocked.props.accessibilityState).toMatchObject({ disabled: true });
    expect(flat(blocked).opacity).toBe(0.5);
    fireEvent.press(blocked);
    expect(onSelectModel).not.toHaveBeenCalled();
  });

  it("shows another engine's models when its chip is tapped, without choosing anything", () => {
    const { onSelectModel, onSelectOption } = renderSheet();

    fireEvent.press(chip("Claude Code"));

    expect(rowNames()).toEqual(["Opus 5, Claude Code"]);
    expect(chip("Claude Code").props.accessibilityState).toMatchObject({ selected: true });
    expect(chip("Matrix AI").props.accessibilityState).toMatchObject({ selected: false });
    expect(within(chip("Matrix AI")).UNSAFE_getByType(ProviderLogo).props.color).toBeUndefined();
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(onSelectOption).not.toHaveBeenCalled();
  });

  it("says why in place of the models when an engine lists none", () => {
    renderSheet();

    fireEvent.press(chip(/^Codex/));

    expect(within(screen.getByTestId("model-sheet-models")).queryAllByRole("button")).toEqual([]);
    expect(flat(screen.getByText("Authentication required"))).toMatchObject({ fontSize: 12, lineHeight: 17, color: "#635F5F" });
  });

  it("opens on the first engine with a model to run when nothing is selected", () => {
    renderSheet({ engines: [codex, claude] });

    expect(chip("Claude Code").props.accessibilityState).toMatchObject({ selected: true });
    expect(rowNames()).toEqual(["Opus 5, Claude Code"]);
  });

  it("keeps a long list of models within two fifths of the window, scrolling inside it", () => {
    renderSheet();

    const models = screen.getByTestId("model-sheet-models");
    // The test window is 1334pt high.
    expect(flat(models)).toMatchObject({ flexGrow: 0, maxHeight: Math.round(1334 * 0.4) });
    expect(models.props.alwaysBounceVertical).toBe(false);
  });
});

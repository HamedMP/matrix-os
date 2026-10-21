import { cleanup, render, screen } from "@testing-library/react-native";
import Svg, { Circle, G, Path, Rect } from "react-native-svg";

import { AgentMascot } from "../components/ui/AgentMascot";

import { flat } from "./ui-test-utils";

describe("AgentMascot", () => {
  afterEach(cleanup);

  it("is a 36pt image named after the agent by default", () => {
    render(<AgentMascot id="account-research" name="Account research" category="Sales" />);

    const mascot = screen.getByLabelText("Account research");
    expect(mascot.props.accessibilityRole).toBe("image");
    expect(flat(mascot)).toMatchObject({ width: 36, height: 36 });
    expect(screen.UNSAFE_getByType(Svg).props).toMatchObject({
      width: 36,
      height: 36,
      viewBox: "0 0 48 48",
    });
  });

  it("takes a size", () => {
    render(<AgentMascot id="account-research" name="Account research" size={48} />);

    expect(flat(screen.getByLabelText("Account research"))).toMatchObject({ width: 48, height: 48 });
    expect(screen.UNSAFE_getByType(Svg).props).toMatchObject({ width: 48, height: 48 });
  });

  it("fills the ears and face with the category's colour and draws the idle ears", () => {
    render(<AgentMascot id="account-research" name="Account research" category="Sales" />);

    const paths = screen.UNSAFE_getAllByType(Path).map((path) => path.props);
    expect(paths.filter((path) => path.fill === "#F07A61").map((path) => path.d)).toEqual([
      "M14 20C12 13 13 5 17 2c5 3 5 12 3 18Z",
      "M28 20c0-8 3-16 7-18 5 4 3 14-1 19Z",
      "M5 28c0-11 8-18 19-18s19 7 19 18-7 17-19 17S5 39 5 28Z",
    ]);
    expect(paths.filter((path) => path.stroke === "#FFE9E3")).toHaveLength(2);
    // The Svg element wraps its children in a group of its own, which has no transform.
    const transforms = screen.UNSAFE_getAllByType(G).map((group) => group.props.transform);
    expect(transforms.filter(Boolean)).toEqual([
      "translate(17.12 19) scale(1 0.96) rotate(-5) translate(-17.12 -20)",
      "translate(32.98 20) scale(1 0.96) rotate(5) translate(-32.98 -21)",
    ]);
  });

  it("draws two dark eyes and no status mark", () => {
    render(<AgentMascot id="account-research" name="Account research" category="Sales" />);

    const eyes = screen.UNSAFE_getAllByType(Rect).map((eye) => eye.props);
    expect(eyes.map((eye) => eye.x)).toEqual([15, 29]);
    expect(eyes.map((eye) => eye.fill)).toEqual(["#17201F", "#17201F"]);
    expect(screen.UNSAFE_queryAllByType(Circle)).toHaveLength(0);
  });

  it("adds the nose only for the ids that have one", () => {
    render(<AgentMascot id="launch-tracker" name="Launch tracker" category="operations" />);

    const noses = screen.UNSAFE_getAllByType(Circle).map((nose) => nose.props);
    expect(noses).toHaveLength(1);
    expect(noses[0]).toMatchObject({ cx: 24, cy: 34, r: 1.35, fill: "#FFF1D9" });
  });
});

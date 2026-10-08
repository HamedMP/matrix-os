import { cleanup, render, screen } from "@testing-library/react-native";

import { CountBadge } from "../components/ui/CountBadge";
import { SectionLabel } from "../components/ui/SectionLabel";
import { StatusDot } from "../components/ui/StatusDot";

import { flat } from "./ui-test-utils";

describe("StatusDot", () => {
  afterEach(cleanup);

  it("is an 8pt circle in the highlight colour while waiting", () => {
    render(<StatusDot testID="dot" tone="waiting" />);

    expect(flat(screen.getByTestId("dot"))).toMatchObject({
      width: 8,
      height: 8,
      borderRadius: 9999,
      backgroundColor: "#E0AA52",
    });
  });

  it("uses the success colour while active", () => {
    render(<StatusDot testID="dot" tone="active" />);

    expect(flat(screen.getByTestId("dot")).backgroundColor).toBe("#288A5B");
  });

  it("is hidden from assistive technology without a label", () => {
    render(<StatusDot testID="dot" tone="active" />);

    const dot = screen.getByTestId("dot");
    expect(dot.props.accessibilityElementsHidden).toBe(true);
    expect(dot.props.importantForAccessibility).toBe("no-hide-descendants");
    expect(dot.props.accessibilityLabel).toBeUndefined();
  });

  it("is announced as an image when it has a label", () => {
    render(<StatusDot tone="waiting" accessibilityLabel="Needs you" />);

    const dot = screen.getByLabelText("Needs you");
    expect(dot.props.accessibilityRole).toBe("image");
    expect(dot.props.accessibilityElementsHidden).toBeFalsy();
  });
});

describe("CountBadge", () => {
  afterEach(cleanup);

  it("is a 16pt highlight pill with the count in 11pt semibold", () => {
    render(<CountBadge testID="badge" count={2} />);

    const style = flat(screen.getByTestId("badge"));
    expect(style).toMatchObject({
      height: 16,
      minWidth: 16,
      paddingHorizontal: 4,
      borderRadius: 9999,
      backgroundColor: "#E0AA52",
      alignItems: "center",
      justifyContent: "center",
    });
    expect(style.borderWidth).toBeUndefined();
    expect(flat(screen.getByText("2"))).toMatchObject({
      fontFamily: "Geist_600SemiBold",
      fontSize: 11,
      lineHeight: 15,
      color: "#FFFFFF",
    });
  });

  it("adds a 1.5pt ring in the background colour outside the 16pt pill", () => {
    render(<CountBadge testID="badge" count={12} bordered />);

    expect(flat(screen.getByTestId("badge"))).toMatchObject({
      borderWidth: 1.5,
      borderColor: "#FFFEFC",
      height: 19,
      minWidth: 19,
    });
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("renders nothing for a count of zero", () => {
    render(<CountBadge testID="badge" count={0} />);

    expect(screen.toJSON()).toBeNull();
  });

  it("takes an accessibility label", () => {
    render(<CountBadge count={3} accessibilityLabel="3 agents need you" />);

    expect(screen.getByLabelText("3 agents need you")).toBeTruthy();
  });
});

describe("SectionLabel", () => {
  afterEach(cleanup);

  it("is an upper-cased 12pt medium heading in the tertiary colour", () => {
    render(<SectionLabel>Recent</SectionLabel>);

    const label = screen.getByRole("header", { name: "Recent" });
    expect(flat(label)).toMatchObject({
      fontFamily: "Geist_500Medium",
      fontSize: 12,
      lineHeight: 17,
      color: "#8A8686",
      textTransform: "uppercase",
    });
    expect(flat(label).letterSpacing).toBeUndefined();
  });
});

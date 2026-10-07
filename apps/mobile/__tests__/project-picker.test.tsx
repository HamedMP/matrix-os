import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { ProjectPicker } from "../components/ProjectPicker";
import type { ProjectSummary } from "../lib/requests";

jest.mock("@expo/ui", () => {
  const { Text, View } = jest.requireActual("react-native") as typeof import("react-native");
  const Picker = (props: { children?: ReactNode }) => <View {...props}>{props.children}</View>;
  Picker.Item = ({ label }: { label: string }) => <Text>{label}</Text>;
  return { Host: ({ children }: { children: ReactNode }) => children, Picker };
});

const projects = [
  { id: "p_local", name: "Notes", kind: "local" },
  { id: "p_gh", name: "matrix-os", kind: "github", github: { owner: "HamedMP", repo: "matrix-os" } },
] as unknown as ProjectSummary[];

describe("ProjectPicker", () => {
  it("renders nothing when there are no projects to choose from", () => {
    render(<ProjectPicker projects={[]} selectedProjectId={null} onSelectionChange={jest.fn()} />);

    expect(screen.queryByTestId("project-picker")).toBeNull();
  });

  it("offers no project first, then each project with its repository", () => {
    render(<ProjectPicker projects={projects} selectedProjectId={null} onSelectionChange={jest.fn()} />);

    expect(screen.getByTestId("project-picker").props.selectedValue).toBe("");
    expect(screen.getByText("No project")).toBeTruthy();
    expect(screen.getByText("Notes")).toBeTruthy();
    expect(screen.getByText("matrix-os (HamedMP/matrix-os)")).toBeTruthy();
  });

  it("reports the chosen project and maps the empty choice back to no project", () => {
    const onSelectionChange = jest.fn();
    render(<ProjectPicker projects={projects} selectedProjectId="p_gh" onSelectionChange={onSelectionChange} />);

    const picker = screen.getByTestId("project-picker");
    expect(picker.props.selectedValue).toBe("p_gh");

    fireEvent(picker, "valueChange", "p_local");
    expect(onSelectionChange).toHaveBeenLastCalledWith("p_local");

    fireEvent(picker, "valueChange", "");
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
  });
});

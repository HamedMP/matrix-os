import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { TaskCard, type Task } from "../components/TaskCard";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    type: "todo",
    status: "pending",
    input: "Buy groceries",
    ...overrides,
  };
}

describe("TaskCard", () => {
  it("renders task input text", () => {
    render(<TaskCard task={task()} onPress={jest.fn()} />);
    expect(screen.getByText("Buy groceries")).toBeTruthy();
  });

  it("shows Todo badge for pending status", () => {
    render(<TaskCard task={task({ status: "pending" })} onPress={jest.fn()} />);
    expect(screen.getByText("Todo")).toBeTruthy();
  });

  it("shows In Progress badge for in-progress status", () => {
    render(<TaskCard task={task({ status: "in-progress" })} onPress={jest.fn()} />);
    expect(screen.getByText("In Progress")).toBeTruthy();
  });

  it("shows Done badge for completed status", () => {
    render(<TaskCard task={task({ status: "completed" })} onPress={jest.fn()} />);
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("shows task type", () => {
    render(<TaskCard task={task({ type: "feature" })} onPress={jest.fn()} />);
    expect(screen.getByText("feature")).toBeTruthy();
  });

  it("shows priority badge when priority > 0", () => {
    render(<TaskCard task={task({ priority: 2 })} onPress={jest.fn()} />);
    expect(screen.getByText("P2")).toBeTruthy();
  });

  it("hides priority badge when priority is 0", () => {
    render(<TaskCard task={task({ priority: 0 })} onPress={jest.fn()} />);
    expect(screen.queryByText("P0")).toBeNull();
  });

  it("hides priority badge when priority is undefined", () => {
    render(<TaskCard task={task()} onPress={jest.fn()} />);
    expect(screen.queryByText(/^P\d/)).toBeNull();
  });

  it("calls onPress when pressed", () => {
    const onPress = jest.fn();
    render(<TaskCard task={task()} onPress={onPress} />);
    fireEvent.press(screen.getByText("Buy groceries"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

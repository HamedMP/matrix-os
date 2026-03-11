import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { TaskDetail } from "../components/TaskDetail";
import type { Task } from "../components/TaskCard";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    type: "todo",
    status: "pending",
    input: "Buy groceries",
    ...overrides,
  };
}

describe("TaskDetail", () => {
  it("renders task title", () => {
    render(<TaskDetail task={task()} onClose={jest.fn()} />);
    expect(screen.getByText("Buy groceries")).toBeTruthy();
  });

  it("renders task type", () => {
    render(<TaskDetail task={task({ type: "feature" })} onClose={jest.fn()} />);
    expect(screen.getByText("feature")).toBeTruthy();
  });

  it("renders task ID", () => {
    render(<TaskDetail task={task({ id: "abc-123" })} onClose={jest.fn()} />);
    expect(screen.getByText("abc-123")).toBeTruthy();
  });

  it("shows Todo status for pending tasks", () => {
    render(<TaskDetail task={task({ status: "pending" })} onClose={jest.fn()} />);
    expect(screen.getByText("Todo")).toBeTruthy();
  });

  it("shows Done status for completed tasks", () => {
    render(<TaskDetail task={task({ status: "completed" })} onClose={jest.fn()} />);
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("shows priority when present", () => {
    render(<TaskDetail task={task({ priority: 3 })} onClose={jest.fn()} />);
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("shows created date when present", () => {
    render(
      <TaskDetail task={task({ createdAt: "2025-01-15" })} onClose={jest.fn()} />,
    );
    expect(screen.getByText("2025-01-15")).toBeTruthy();
  });

  it("shows Mark Complete for pending tasks", () => {
    render(
      <TaskDetail
        task={task({ status: "pending" })}
        onClose={jest.fn()}
        onStatusChange={jest.fn()}
      />,
    );
    expect(screen.getByText("Mark Complete")).toBeTruthy();
  });

  it("shows Reopen Task for completed tasks", () => {
    render(
      <TaskDetail
        task={task({ status: "completed" })}
        onClose={jest.fn()}
        onStatusChange={jest.fn()}
      />,
    );
    expect(screen.getByText("Reopen Task")).toBeTruthy();
  });

  it("calls onClose when close button pressed", () => {
    const onClose = jest.fn();
    render(<TaskDetail task={task()} onClose={onClose} />);
    fireEvent.press(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onStatusChange with completed when Mark Complete pressed", async () => {
    const onStatusChange = jest.fn().mockResolvedValue(undefined);
    const onClose = jest.fn();
    render(
      <TaskDetail
        task={task({ status: "pending" })}
        onClose={onClose}
        onStatusChange={onStatusChange}
      />,
    );
    fireEvent.press(screen.getByText("Mark Complete"));
    await waitFor(() => {
      expect(onStatusChange).toHaveBeenCalledWith("task-1", "completed");
    });
  });

  it("calls onStatusChange with pending when Reopen pressed", async () => {
    const onStatusChange = jest.fn().mockResolvedValue(undefined);
    const onClose = jest.fn();
    render(
      <TaskDetail
        task={task({ status: "completed" })}
        onClose={onClose}
        onStatusChange={onStatusChange}
      />,
    );
    fireEvent.press(screen.getByText("Reopen Task"));
    await waitFor(() => {
      expect(onStatusChange).toHaveBeenCalledWith("task-1", "pending");
    });
  });
});

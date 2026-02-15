import { describe, it, expect } from "vitest";

describe("Task Manager app", () => {
  interface Task {
    id: string;
    type: string;
    status: string;
    assignedTo: string | null;
    input: string;
    output: string | null;
    priority: number;
    createdAt: number;
    claimedAt: number | null;
    completedAt: number | null;
    dependsOn: string | null;
  }

  const sampleTasks: Task[] = [
    {
      id: "task-1",
      type: "todo",
      status: "pending",
      assignedTo: null,
      input: JSON.stringify({ message: "Fix the login bug" }),
      output: null,
      priority: 2,
      createdAt: Date.now() - 3600000,
      claimedAt: null,
      completedAt: null,
      dependsOn: null,
    },
    {
      id: "task-2",
      type: "kernel",
      status: "in_progress",
      assignedTo: "builder",
      input: JSON.stringify({ message: "Build a weather widget" }),
      output: null,
      priority: 1,
      createdAt: Date.now() - 7200000,
      claimedAt: Date.now() - 3600000,
      completedAt: null,
      dependsOn: null,
    },
    {
      id: "task-3",
      type: "todo",
      status: "completed",
      assignedTo: "researcher",
      input: JSON.stringify({ message: "Research API options" }),
      output: JSON.stringify({ result: "Found 3 options" }),
      priority: 0,
      createdAt: Date.now() - 86400000,
      claimedAt: Date.now() - 80000000,
      completedAt: Date.now() - 72000000,
      dependsOn: null,
    },
    {
      id: "task-4",
      type: "todo",
      status: "failed",
      assignedTo: "deployer",
      input: JSON.stringify({ message: "Deploy to production" }),
      output: JSON.stringify({ error: "Connection timeout" }),
      priority: 3,
      createdAt: Date.now() - 1800000,
      claimedAt: Date.now() - 1200000,
      completedAt: Date.now() - 600000,
      dependsOn: null,
    },
  ];

  describe("status filtering", () => {
    it("filters by pending status", () => {
      const filtered = sampleTasks.filter((t) => t.status === "pending");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("task-1");
    });

    it("filters by in_progress status", () => {
      const filtered = sampleTasks.filter((t) => t.status === "in_progress");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].assignedTo).toBe("builder");
    });

    it("filters by completed status", () => {
      const filtered = sampleTasks.filter((t) => t.status === "completed");
      expect(filtered).toHaveLength(1);
    });

    it("shows all tasks when no filter applied", () => {
      expect(sampleTasks).toHaveLength(4);
    });
  });

  describe("kanban grouping", () => {
    it("groups tasks into kanban columns by status", () => {
      const columns: Record<string, Task[]> = {};
      for (const task of sampleTasks) {
        if (!columns[task.status]) columns[task.status] = [];
        columns[task.status].push(task);
      }

      expect(Object.keys(columns).sort()).toEqual(
        ["completed", "failed", "in_progress", "pending"],
      );
      expect(columns["pending"]).toHaveLength(1);
      expect(columns["in_progress"]).toHaveLength(1);
      expect(columns["completed"]).toHaveLength(1);
      expect(columns["failed"]).toHaveLength(1);
    });

    it("sorts tasks within columns by priority descending", () => {
      const pendingAndInProgress = sampleTasks
        .filter((t) => t.status === "pending" || t.status === "in_progress")
        .sort((a, b) => b.priority - a.priority);

      expect(pendingAndInProgress[0].priority).toBeGreaterThanOrEqual(
        pendingAndInProgress[1].priority,
      );
    });
  });

  describe("input parsing", () => {
    it("extracts message from JSON input", () => {
      const task = sampleTasks[0];
      const parsed = JSON.parse(task.input);
      expect(parsed.message).toBe("Fix the login bug");
    });

    it("handles plain string input gracefully", () => {
      const plainInput = "Just a plain string";
      let display: string;
      try {
        const parsed = JSON.parse(plainInput);
        display = parsed.message ?? plainInput;
      } catch {
        display = plainInput;
      }
      expect(display).toBe("Just a plain string");
    });

    it("extracts output from completed tasks", () => {
      const task = sampleTasks[2];
      const parsed = JSON.parse(task.output!);
      expect(parsed.result).toBe("Found 3 options");
    });

    it("extracts error from failed tasks", () => {
      const task = sampleTasks[3];
      const parsed = JSON.parse(task.output!);
      expect(parsed.error).toBe("Connection timeout");
    });
  });

  describe("priority display", () => {
    it("maps priority numbers to labels", () => {
      function priorityLabel(p: number): string {
        if (p >= 3) return "urgent";
        if (p >= 2) return "high";
        if (p >= 1) return "medium";
        return "low";
      }

      expect(priorityLabel(3)).toBe("urgent");
      expect(priorityLabel(2)).toBe("high");
      expect(priorityLabel(1)).toBe("medium");
      expect(priorityLabel(0)).toBe("low");
    });
  });

  describe("task creation payload", () => {
    it("builds valid POST body for new task", () => {
      const input = "Set up monitoring dashboard";
      const body = { type: "todo", input, priority: 1 };

      expect(body.type).toBe("todo");
      expect(body.input).toBe(input);
      expect(body.priority).toBe(1);
    });
  });

  describe("relative time display", () => {
    it("shows relative time for recent tasks", () => {
      function relativeTime(ts: number): string {
        const diff = Date.now() - ts;
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return "just now";
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
      }

      expect(relativeTime(Date.now())).toBe("just now");
      expect(relativeTime(Date.now() - 300000)).toBe("5m ago");
      expect(relativeTime(Date.now() - 7200000)).toBe("2h ago");
      expect(relativeTime(Date.now() - 172800000)).toBe("2d ago");
    });
  });

  describe("matrix.md manifest", () => {
    it("has required fields", () => {
      const manifest = {
        name: "Task Manager",
        description: "Manage kernel tasks with kanban and list views",
        icon: "C",
        category: "productivity",
        theme_accent: "#7C3AED",
        data_dir: "~/data/task-manager/",
        author: "system",
        version: 1,
      };

      expect(manifest.name).toBe("Task Manager");
      expect(manifest.category).toBe("productivity");
      expect(manifest.icon).toBeTruthy();
      expect(manifest.author).toBe("system");
    });
  });
});

import type { CanonicalChatRecord } from "@matrix-os/contracts";

import { ProjectRequestError, type ProjectSummary } from "../lib/requests/projects";
import { archiveFailureMessage, projectNameFailure } from "../components/projects/project-failures";
import { projectChatRows, projectRow, projectRows } from "../components/projects/project-rows";

/** Thursday 8 October 2026, 12:00 local time. */
const NOW = new Date(2026, 9, 8, 12, 0, 0);

function at(day: number, hour: number): string {
  return new Date(2026, 9, day, hour, 0, 0).toISOString();
}

function project(fields: { id: string; name: string; updatedAt?: string }): ProjectSummary {
  return { slug: fields.id, kind: "scratch", ...fields };
}

const portfolio = project({ id: "proj_portfolio", name: "Portfolio", updatedAt: at(8, 9) });
const matrix = project({ id: "proj_matrix", name: "Matrix", updatedAt: at(7, 18) });
const admin = project({ id: "proj_admin", name: "Admin", updatedAt: new Date(2026, 8, 30, 10).toISOString() });
const untimed = project({ id: "proj_untimed", name: "Field notes" });

type Chat = CanonicalChatRecord["chat"];

function chat(fields: Partial<Chat> & { id: string }): CanonicalChatRecord {
  return {
    chat: {
      ownerScope: { type: "personal", ownerId: "user_a" },
      title: "",
      lifecycle: "active",
      attention: "none",
      revision: 1,
      messageCount: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...fields,
    } as Chat,
    projectId: "proj_portfolio",
  };
}

describe("projectRow", () => {
  it("names the project and words when it last changed", () => {
    expect(projectRow(portfolio, NOW)).toEqual({ id: "proj_portfolio", name: "Portfolio", updated: "Updated today" });
    expect(projectRow(matrix, NOW).updated).toBe("Updated yesterday");
    expect(projectRow(admin, NOW).updated).toBe("Updated Sep 30");
  });

  it("leaves the time out when the project carries none, or one that is not a date", () => {
    expect(projectRow(untimed, NOW)).toEqual({ id: "proj_untimed", name: "Field notes" });
    expect(projectRow(project({ id: "proj_odd", name: "Odd", updatedAt: "soon" }), NOW).updated).toBeUndefined();
  });
});

describe("projectRows", () => {
  const all = [portfolio, matrix, admin, untimed];

  it("lists every project in the order given while there is no search", () => {
    expect(projectRows(all, "", NOW).map((row) => row.name)).toEqual(["Portfolio", "Matrix", "Admin", "Field notes"]);
    expect(projectRows(all, "   ", NOW)).toHaveLength(4);
  });

  it("keeps the projects whose name contains the search, whatever the case and the space around it", () => {
    expect(projectRows(all, "  MAT ", NOW).map((row) => row.id)).toEqual(["proj_matrix"]);
    expect(projectRows(all, "o", NOW).map((row) => row.name)).toEqual(["Portfolio", "Field notes"]);
    expect(projectRows(all, "nothing like it", NOW)).toEqual([]);
  });

  it("searches the name only", () => {
    expect(projectRows(all, "proj_", NOW)).toEqual([]);
    expect(projectRows(all, "updated", NOW)).toEqual([]);
  });
});

describe("projectChatRows", () => {
  it("shows each chat's title, last message on one line, and last activity", () => {
    const rows = projectChatRows([
      chat({ id: "chat_case", title: " Case study ", lastMessagePreview: "Draft ready\n to  review", activityAt: at(8, 10) }),
      chat({ id: "chat_landing", title: "Landing page copy", lastMessagePreview: "Three headline options", updatedAt: at(7, 9) }),
    ], NOW);

    expect(rows).toEqual([
      { id: "chat_case", title: "Case study", preview: "Draft ready to review", time: "2h" },
      { id: "chat_landing", title: "Landing page copy", preview: "Three headline options", time: "Yesterday" },
    ]);
  });

  it("dates a chat by its activity rather than by its last change", () => {
    const [row] = projectChatRows([chat({ id: "chat_a", title: "A", activityAt: at(5, 12), updatedAt: at(8, 11) })], NOW);

    expect(row.time).toBe("Mon");
  });

  it("calls an untitled chat New chat and leaves an empty preview out", () => {
    const [row] = projectChatRows([chat({ id: "chat_blank", title: "  ", lastMessagePreview: "  ", updatedAt: at(8, 11) })], NOW);

    expect(row).toEqual({ id: "chat_blank", title: "New chat", time: "1h" });
  });

  it("leaves the time out when it cannot be read", () => {
    const [row] = projectChatRows([chat({ id: "chat_odd", title: "Odd", updatedAt: "never" })], NOW);

    expect(row).toEqual({ id: "chat_odd", title: "Odd" });
  });
});

describe("projectNameFailure", () => {
  it("says the name is taken when the server says so", () => {
    expect(projectNameFailure(new ProjectRequestError("name_taken"), "Project could not be created. Try again."))
      .toBe("A project with that name already exists.");
  });

  it.each([
    new ProjectRequestError("invalid_name"),
    new ProjectRequestError("conflict"),
    new ProjectRequestError("not_found"),
    new ProjectRequestError("unavailable"),
    new Error("upstream said no"),
    "upstream said no",
    null,
  ])("gives the generic line for anything else (%p)", (failure) => {
    expect(projectNameFailure(failure, "Project could not be renamed. Try again."))
      .toBe("Project could not be renamed. Try again.");
  });
});

describe("archiveFailureMessage", () => {
  it("says work is running when the server refuses for that reason", () => {
    expect(archiveFailureMessage(new ProjectRequestError("project_active")))
      .toBe("This project has work running. Try again when it finishes.");
  });

  it.each([
    new ProjectRequestError("conflict"),
    new ProjectRequestError("not_found"),
    new ProjectRequestError("unavailable"),
    new Error("upstream said no"),
    undefined,
  ])("gives a generic message for anything else (%p)", (failure) => {
    expect(archiveFailureMessage(failure)).toBe("Try again.");
  });
});

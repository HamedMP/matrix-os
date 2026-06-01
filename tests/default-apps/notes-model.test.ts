import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildNotePreview,
  createNote,
  extractTags,
  filterNotes,
  normalizeTags,
  tiptapDocToText,
  type Note,
} from "../../home/apps/notes/src/notes-model";

const REPO_ROOT = join(__dirname, "..", "..");

describe("notes model", () => {
  it("creates searchable notes with tags extracted from markdown content", () => {
    const note = createNote({
      title: "Launch plan",
      content: "# Roadmap\nShip the #Canvas upgrade with #AI review notes.",
    });

    expect(note.tags).toEqual(["canvas", "ai"]);
    expect(note.preview).toBe("Roadmap Ship the #Canvas upgrade with #AI review notes.");
  });

  it("filters across title, content, and tags while keeping pinned notes first", () => {
    const notes: Note[] = [
      createNote({ title: "Inbox zero", content: "Email triage", pinned: false }),
      createNote({ title: "Canvas sprint", content: "Board polish #work", pinned: true }),
      createNote({ title: "Weekend", content: "Groceries #personal", pinned: true }),
    ];

    expect(filterNotes(notes, "work").map((note) => note.title)).toEqual(["Canvas sprint"]);
    expect(filterNotes(notes, "").map((note) => note.title)).toEqual([
      "Weekend",
      "Canvas sprint",
      "Inbox zero",
    ]);
  });

  it("deduplicates tags and strips common markdown from previews", () => {
    expect(extractTags("Meet #Team, #team, and #Research-Ops")).toEqual([
      "team",
      "research-ops",
    ]);
    expect(normalizeTags(["a", "ai", "#b", "board"])).toEqual(["ai", "board"]);
    expect(buildNotePreview("- [ ] Review **spec**\n```ts\nconst x = 1\n```")).toBe(
      "Review spec",
    );
  });

  it("keeps Tiptap JSON as the canonical rich document shape", () => {
    const note = createNote({
      title: "Research",
      content: "Research #ai",
      content_json: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Research " },
              { type: "text", text: "#AI" },
            ],
          },
        ],
      },
    });

    expect(note.content_json.type).toBe("doc");
    expect(tiptapDocToText(note.content_json)).toBe("Research #AI");
    expect(note.tags).toEqual(["ai"]);
  });

  it("declares an index for stored tag strings", () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "home", "apps", "notes", "matrix.json"), "utf-8"),
    ) as { storage?: { tables?: { notes?: { indexes?: string[] } } } };

    expect(manifest.storage?.tables?.notes?.indexes).toContain("tags");
  });
});

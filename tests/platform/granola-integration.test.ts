import { describe, expect, it } from "vitest";
import {
  GRANOLA_PRESET,
  planGranolaAction,
} from "../../packages/platform/src/granola-integration.js";

const tools = [
  {
    name: "query_granola_meetings",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "list_meeting_folders",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_meetings",
    inputSchema: {
      type: "object",
      properties: {
        folder_id: { type: "string" },
        time_range: { type: "string" },
        page_size: { type: "number" },
      },
    },
  },
  {
    name: "get_meetings",
    inputSchema: { type: "object", properties: { meeting_ids: { type: "array" } } },
  },
  {
    name: "get_meeting_transcript",
    inputSchema: { type: "object", properties: { meeting_id: { type: "string" } } },
  },
  {
    name: "get_account_info",
    inputSchema: { type: "object", properties: {} },
  },
];

describe("Granola managed integration", () => {
  it("allowlists every currently documented read-only Granola tool", () => {
    expect(GRANOLA_PRESET.tools).toEqual([
      "query_granola_meetings",
      "list_meeting_folders",
      "list_meetings",
      "get_meetings",
      "get_meeting_transcript",
      "get_account_info",
    ]);
    expect(GRANOLA_PRESET.requiredTools).toEqual(["list_meetings", "get_meetings"]);
  });

  it("maps stable search and list params to discovered upstream schemas", () => {
    expect(planGranolaAction("search_notes", { query: "decisions about launch" }, tools)).toEqual({
      calls: [{
        toolName: "query_granola_meetings",
        arguments: { query: "decisions about launch" },
      }],
      combine: false,
    });
    expect(planGranolaAction("list_notes", {
      folderId: "folder-1",
      timeRange: "last 30 days",
      limit: 25,
      ignored: "do not forward",
    }, tools)).toEqual({
      calls: [{
        toolName: "list_meetings",
        arguments: {
          folder_id: "folder-1",
          time_range: "last 30 days",
          page_size: 25,
        },
      }],
      combine: false,
    });
  });

  it("maps note IDs against each discovered tool schema and combines transcripts", () => {
    expect(planGranolaAction("get_note", {
      noteId: "meeting-1",
      includeTranscript: true,
    }, tools)).toEqual({
      calls: [
        { toolName: "get_meetings", arguments: { meeting_ids: ["meeting-1"] } },
        { toolName: "get_meeting_transcript", arguments: { meeting_id: "meeting-1" } },
      ],
      combine: true,
    });
  });

  it("supports folder and account reads without forwarding caller input", () => {
    expect(planGranolaAction("list_folders", { ignored: true }, tools)).toEqual({
      calls: [{ toolName: "list_meeting_folders", arguments: {} }],
      combine: false,
    });
    expect(planGranolaAction("get_account", { ignored: true }, tools)).toEqual({
      calls: [{ toolName: "get_account_info", arguments: {} }],
      combine: false,
    });
  });

  it("fails closed when a required upstream schema mapping is unavailable", () => {
    expect(() => planGranolaAction("get_note", { noteId: "meeting-1" }, [
      { name: "get_meetings", inputSchema: { type: "object", properties: { unknown: {} } } },
    ])).toThrow("Granola get_meetings schema has no supported meeting identifier");
    expect(() => planGranolaAction("search_notes", { query: "launch" }, [
      { name: "query_granola_meetings", inputSchema: { type: "object", properties: { unknown: {} } } },
    ])).toThrow("Granola query_granola_meetings schema has no supported query field");
  });

  it("bounds stable action inputs before they reach Granola", () => {
    expect(planGranolaAction("list_notes", { limit: 10_000 }, tools)).toMatchObject({
      calls: [{ arguments: { page_size: 100 } }],
    });
    expect(() => planGranolaAction("list_notes", { limit: Number.NaN }, tools)).toThrow(
      "Granola limit is invalid",
    );
    expect(() => planGranolaAction("get_note", { noteId: "x".repeat(513) }, tools)).toThrow(
      "Granola noteId is invalid",
    );
    expect(() => planGranolaAction("search_notes", { query: "x".repeat(4_001) }, tools)).toThrow(
      "Granola query is invalid",
    );
  });
});

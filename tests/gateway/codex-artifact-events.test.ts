import { describe, expect, it } from "vitest";
import { extractCodexArtifactRecords } from "../../packages/gateway/src/coding-agents/codex-artifact-events.mjs";

describe("Codex app-server artifact extraction", () => {
  it("extracts generated and viewed image files", () => {
    expect(extractCodexArtifactRecords({
      id: "generated_1",
      type: "imageGeneration",
      status: "completed",
      result: "",
      savedPath: "/verified/run/whale.png",
    })).toEqual([expect.objectContaining({
      type: "matrix.codex.artifact.available",
      providerItemId: "generated_1",
      outputIndex: 0,
      source: { type: "run_file", path: "/verified/run/whale.png" },
      label: "whale.png",
      mimeType: "image/png",
    })]);

    expect(extractCodexArtifactRecords({
      id: "view_1",
      type: "imageView",
      path: "/verified/run/chart.webp",
    })[0]).toMatchObject({ providerItemId: "view_1", label: "chart.webp", mimeType: "image/webp" });
  });

  it("extracts function and dynamic tool image or audio content", () => {
    expect(extractCodexArtifactRecords({
      id: "function_1",
      type: "functionCallOutput",
      name: "render",
      output: [
        { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
        { type: "input_audio", audio_url: "file:///verified/run/voice.mp3" },
        { type: "input_text", text: "not an artifact" },
        { type: "encrypted_content", encrypted_content: "private" },
      ],
    })).toEqual([
      expect.objectContaining({
        providerItemId: "function_1",
        outputIndex: 0,
        source: { type: "inline_bytes", mimeType: "image/png", base64: "iVBORw0KGgo=" },
      }),
      expect.objectContaining({
        providerItemId: "function_1",
        outputIndex: 1,
        source: { type: "run_file", path: "/verified/run/voice.mp3" },
        mimeType: "audio/mpeg",
      }),
    ]);

    expect(extractCodexArtifactRecords({
      id: "dynamic_1",
      type: "dynamicToolCall",
      contentItems: [{ type: "inputAudio", audioUrl: "data:audio/wav;base64,UklGRg==" }],
    })[0]).toMatchObject({
      providerItemId: "dynamic_1",
      source: { type: "inline_bytes", mimeType: "audio/wav", base64: "UklGRg==" },
    });
  });

  it("extracts standard MCP image, audio, embedded resource and local resource links", () => {
    const records = extractCodexArtifactRecords({
      id: "mcp_1",
      type: "mcpToolCall",
      result: {
        content: [
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          { type: "audio", data: "UklGRg==", mimeType: "audio/wav" },
          { type: "resource", resource: { uri: "file:///verified/run/report.pdf", mimeType: "application/pdf", blob: "JVBERg==" } },
          { type: "resource_link", uri: "file:///verified/run/data.csv", name: "sales.csv", mimeType: "text/csv" },
          { type: "text", text: "not an artifact" },
        ],
      },
    });

    expect(records).toHaveLength(4);
    expect(records.map((record) => record.mimeType)).toEqual([
      "image/png",
      "audio/wav",
      "application/pdf",
      "text/csv",
    ]);
    expect(records[2]).toMatchObject({ source: { type: "inline_bytes", base64: "JVBERg==" } });
    expect(records[3]).toMatchObject({ source: { type: "run_file", path: "/verified/run/data.csv" }, label: "sales.csv" });
  });

  it("does not turn remote URLs, failed generations or arbitrary tool text into artifacts", () => {
    expect(extractCodexArtifactRecords({
      id: "remote_1",
      type: "dynamicToolCall",
      contentItems: [{ type: "inputImage", imageUrl: "https://example.invalid/private.png" }],
    })).toEqual([]);
    expect(extractCodexArtifactRecords({
      id: "failed_1",
      type: "imageGeneration",
      status: "failed",
      result: "data:image/png;base64,iVBORw0KGgo=",
      savedPath: null,
      failure: { type: "usageLimitExceeded", limitId: "image" },
    })).toEqual([]);
    expect(extractCodexArtifactRecords({
      id: "command_1",
      type: "commandExecution",
      aggregatedOutput: "/verified/run/secret.png",
    })).toEqual([]);
  });

  it("bounds inline bytes and output counts", () => {
    const content = Array.from({ length: 12 }, (_, index) => ({
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/png",
      index,
    }));
    expect(extractCodexArtifactRecords({ id: "mcp_many", type: "mcpToolCall", result: { content } })).toHaveLength(8);
    const leadingText = Array.from({ length: 8 }, () => ({ type: "text", text: "status" }));
    expect(extractCodexArtifactRecords({
      id: "mcp_late_image",
      type: "mcpToolCall",
      result: { content: [...leadingText, ...content] },
    })).toEqual(expect.arrayContaining([expect.objectContaining({ outputIndex: 0 })]));
    expect(extractCodexArtifactRecords({
      id: "mcp_late_image",
      type: "mcpToolCall",
      result: { content: [...leadingText, ...content] },
    })).toHaveLength(8);
    expect(extractCodexArtifactRecords({
      id: "too_large",
      type: "functionCallOutput",
      output: [{ type: "input_image", image_url: `data:image/png;base64,${"A".repeat(12 * 1024 * 1024 + 1)}` }],
    })).toEqual([]);
  });
});

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import { parseCodexExecJsonLine } from "../../packages/gateway/src/coding-agents/codex-events.js";
import { codexToolOutput, coarseToolOutputText } from "../../packages/gateway/src/coding-agents/codex-tool-output.mjs";

const unavailable = "Generated image output is unavailable in this Matrix version.";

describe("Codex 0.164 image output compatibility", () => {
  it.each([{ fileId: "opaque-image" }, { fileId: "opaque-image", result: "" }])("reports unsupported completed file-only output safely: %j", fields => {
    const item = { id: "image", type: "imageGeneration", status: "completed", ...fields,
      inputImages: [{ path: "/private/fixture-input.png", sha256: "private-input-hash" }] };
    expect(codexToolOutput(item)).toEqual({ text: unavailable, truncated: true });
    expect(coarseToolOutputText(unavailable)).toBe(unavailable);
    expect(coarseToolOutputText(`${unavailable} private-extra`)).toBe("Tool output is private to its owner.");
  });

  it.each(["inProgress", "failed"])("does not claim a completed unsupported output for %s", status => {
    expect(codexToolOutput({ type: "imageGeneration", status, fileId: "opaque-image" })).toBeUndefined();
  });

  it("preserves actual runner artifacts and truthful terminal success while making file-only output explicit", async () => {
    const home = await mkdtemp("/tmp/codex-0164-images-");
    const eventPath = codexProviderEventPath(home, "sess_image_0164");
    const fakePath = join(home, "fake.mjs");
    const imagePath = join(home, "image.png");
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const common = { type: "imageGeneration", status: "completed", fileId: "private-opaque-file",
      inputImages: [{ path: "/private/fixture-input.png", sha256: "private-input-hash" }] };
    const items = [{ ...common, id: "file-only" }, { ...common, id: "migration-file", result: "" },
      { ...common, id: "saved-image", savedPath: imagePath },
      { ...common, id: "inline-image", result: "data:image/png;base64,iVBORw0KGgo=" },
      { ...common, id: "failed-image", status: "failed" }];
    await writeFile(fakePath, [
      "import { createInterface } from 'node:readline';",
      "for await (const line of createInterface({input:process.stdin})) {",
      " const m=JSON.parse(line);",
      " if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{userAgent:'fixture'}}));",
      " if(m.method==='thread/start') console.log(JSON.stringify({id:m.id,result:{thread:{id:'thread-image'}}}));",
      " if(m.method==='turn/start') {",
      "  console.log(JSON.stringify({id:m.id,result:{turn:{id:'turn-image',status:'inProgress',items:[]}}}));",
      `  for(const item of ${JSON.stringify(items)}) {`,
      "   console.log(JSON.stringify({method:'item/started',params:{turnId:'turn-image',item:{...item,status:'inProgress'}}}));",
      "   console.log(JSON.stringify({method:'item/completed',params:{turnId:'turn-image',item}}));",
      "  }",
      "  console.log(JSON.stringify({method:'turn/completed',params:{turn:{id:'turn-image',status:'completed',items:[]}}}));",
      "  process.exit(0);",
      " }",
      "}",
    ].join("\n"));
    const config = Buffer.from(JSON.stringify({ prompt: "Fixture", approvalPolicy: "on-request", sandbox: "workspace-write", writableRoots: [home] })).toString("base64");
    const child = spawn(process.execPath, [join(process.cwd(), "packages/gateway/src/coding-agents/codex-app-server-runner.mjs"),
      eventPath, process.version.slice(1), process.execPath, fakePath, config], {
      cwd: home, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, ".codex") }, stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8_192); });
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      expect({ code: await closed, stderr }).toEqual({ code: 0, stderr: "" });
      const transcript = await readFile(eventPath, "utf8");
      const records = transcript.trim().split("\n").map(line => JSON.parse(line));
      const outputs = records.filter(entry => entry.type === "matrix.codex.tool.output" && entry.text === unavailable);
      expect(outputs).toHaveLength(2);
      const artifacts = records.filter(entry => entry.type === "matrix.codex.artifact.available");
      expect(artifacts.map(entry => entry.providerItemId)).toEqual(["saved-image", "inline-image"]);
      expect(await readFile(join(home, artifacts[1].ownerReference))).toEqual(Buffer.from("iVBORw0KGgo=", "base64"));
      for (const output of outputs) {
        expect(records).toContainEqual(expect.objectContaining({ type: "matrix.codex.tool.completed", toolCallId: output.toolCallId, outcome: "success" }));
        const projected = parseCodexExecJsonLine(JSON.stringify(output), { threadId: "thread_matrix_image", now: () => new Date("2026-10-23T12:00:00Z"), nextEventId: () => "evt_image" });
        expect(JSON.stringify(projected.events)).toContain(unavailable);
      }
      expect(records.at(-1)).toMatchObject({ type: "turn.completed" });
      expect(transcript).not.toMatch(/private-opaque-file|fixture-input|private-input-hash|inputImages|iVBORw0KGgo=/);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      await rm(home, { recursive: true, force: true });
    }
  });
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { expect, it, vi } from "vitest";

it.each(["source_limit", "raw-provider-error"])("allowlists the broker's %s error before presenting a Bot message", async errorCode => {
  const directory = await mkdtemp(join(tmpdir(), "omb-provider-error-"));
  const socket = join(directory, "model.sock");
  const source = await readFile("scripts/openmausbot/matrix-provider.ts", "utf8");
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 } }).outputText;
  const contractImport = 'import { newEventId } from "../contracts.ts";';
  expect(compiled).toContain(contractImport);
  const filename = join(directory, "driver.mjs");
  await writeFile(filename, compiled.replace(contractImport, 'const newEventId = () => "fixture-event";')
    .replace('"/matrix-drive/model.sock"', JSON.stringify(socket)));
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: errorCode }));
  });
  const paired = process.env.OMB_MATRIX_PAIR_SOCKET;
  process.env.OMB_MATRIX_PAIR_SOCKET = "/synthetic-pairing";
  await new Promise<void>(resolve => server.listen(socket, resolve));
  let instance: { dispose(): Promise<void> } | undefined;
  try {
    const runtime = await import(pathToFileURL(filename).href);
    const created = await runtime.matrixHostedDriver.create({ instanceId: runtime.MATRIX_HOSTED_INSTANCE, enabled: true });
    instance = created;
    const events: Array<{ type: string; message?: string; ok?: boolean }> = [];
    created.adapter.onEvent((event: { type: string }) => events.push(event));
    const identity = { botId: "basil", threadId: "main", sendId: "0123456789abcdef" };
    await runtime.runMatrixHostedModelTurn(runtime.MATRIX_HOSTED_INSTANCE, {
      ...identity, token: "a".repeat(64),
    }, [], new Set(), () => created.adapter.sendTurn({
      ...identity, model: runtime.MATRIX_HOSTED_MODEL,
    }));
    await vi.waitFor(() => expect(events.some(event => event.type === "turn.completed")).toBe(true));
    expect(calls).toBe(1);
    expect(events.find(event => event.type === "runtime.error")?.message).toBe(errorCode === "source_limit"
      ? "This model's free usage is currently unavailable. Choose another model."
      : "Matrix AI could not complete this message. Send a new message to retry.");
    expect(events.find(event => event.type === "turn.completed")?.ok).toBe(false);
    expect(events.some(event => event.type === "item.completed")).toBe(false);
  } finally {
    await instance?.dispose();
    if (paired === undefined) delete process.env.OMB_MATRIX_PAIR_SOCKET;
    else process.env.OMB_MATRIX_PAIR_SOCKET = paired;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

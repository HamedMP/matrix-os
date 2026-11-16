// Native OpenCode loader/auth/model/HTTP-server are named fixtures. The owned tool module and FD are real.
import { readFile, appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const fixture = JSON.parse(await readFile(process.argv[2], "utf8"));
const tool = (await import(pathToFileURL(fixture.tool))).default;
let running = false, ended = false;
const controller = new AbortController();
async function record(value) { await appendFile(fixture.records, JSON.stringify(value) + "\n"); }
async function tick() {
  let frame;
  try { frame = JSON.parse(await readFile(fixture.control, "utf8")); } catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return; throw error; }
  if (frame.type === "exit") process.exit(0);
  if (frame.type === "eof" && !ended) { ended = true; process.stdout.end(); return; }
  if (frame.type === "cancel") { controller.abort(); return; }
  if (frame.type !== "tool" || running) return;
  running = true;
  await record({ context: frame.context, intent: frame.intent });
  const native = { ...frame.context, abort: controller.signal, ask: async () => { throw new Error("Unapproved native ask"); }, metadata() {} };
  const result = await tool.execute({ intent: frame.intent }, native);
  await record({ result });
  if (fixture.duplicate) await record({ duplicate: await tool.execute({ intent: frame.intent }, native) });
}
process.stdout.write("opencode server listening on http://127.0.0.1:43219\n");
const timer = setInterval(() => { void tick().catch(async error => { await record({ error: error.name }); process.exit(1); }); }, 10);
setTimeout(() => { clearInterval(timer); process.exit(2); }, 30000).unref();

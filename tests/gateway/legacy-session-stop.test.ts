import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { createZellijAdapter } from "../../packages/gateway/src/shell/zellij.js";
import { stopLegacySession } from "../../packages/gateway/src/legacy-session-stop.js";

const names = ["matrix-rt_old", "matrix-sess_11111111-2222-4333-8444-555555555555", "sess_11111111-2222-4333-8444-555555555555"];
it.each(names.flatMap((name) => ["missing", "empty", "running", "still_running", "unavailable"].map((state) => ({ name, state }))))(
  "uses the real legacy adapter for $name ($state)", async ({ name, state }) => {
  const calls: string[][] = [];
  const execFile = vi.fn((_file, args, _opts, callback) => {
    calls.push(args);
    if (state === "running") callback(null, "", "");
    else if (args[0] === "delete-session") callback(Object.assign(new Error("delete failed"), { code: 1 }), "", "delete failed");
    else if (state === "empty") callback(Object.assign(new Error("no sessions"), { code: 1 }), "", "No active zellij sessions found.");
    else if (state === "unavailable") callback(Object.assign(new Error("permission denied"), { code: 1 }), "", "permission denied");
    else callback(null, state === "still_running" ? `${name} [Created 1d ago]\n` : "matrix-rt_other [Created 1d ago]\n", "");
    return new EventEmitter();
  });
  const adapter = createZellijAdapter({ execFile: execFile as never, spawnPty: vi.fn(), manageConfig: false });
  const result = stopLegacySession(name, adapter);
  if (["unavailable", "still_running"].includes(state)) await expect(result).rejects.toThrow();
  else await expect(result).resolves.toBeUndefined();
  expect(calls[0]).toEqual(["delete-session", name, "--force"]);
  if (state !== "running") expect(calls[1]).toEqual(["list-sessions", "--no-formatting"]);
});

it("rejects malformed or non-Matrix runtime names before invoking the adapter", async () => {
  const deleteSession = vi.fn();
  for (const name of [undefined, "--all", "unrelated", "matrix-../bad", "sess_unrelated", "sess_../bad", "sess_11111111-2222-4333-8444-555555555555 --all"]) {
    await expect(stopLegacySession(name, { deleteSession })).rejects.toThrow();
  }
  expect(deleteSession).not.toHaveBeenCalled();
});

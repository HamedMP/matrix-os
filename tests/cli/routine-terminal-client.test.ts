import { ROUTINE_CLI_SAFE_ERRORS } from "@matrix-os/contracts/routine-cli";
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { executeTerminalRoutineOperation, validateTerminalBrokerLocation } from "../../packages/sync-client/src/cli/routine-terminal-client.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
describe("ordinary CLI Terminal broker discovery is a location only", () => {
  it.each(['http://localhost/x', '/tmp/routine.sock', 'unix:///tmp/x', '/tmp/matrix-terminal-' + 'a'.repeat(32) + '/../routine.sock', '/tmp/matrix-terminal-' + 'a'.repeat(32) + '/routine.sock?owner=me'])('rejects invalid location %s', value => {
    expect(() => validateTerminalBrokerLocation(value)).toThrow();
  });
  it("keeps write direction open until validated result; sends only strict operation", async () => {
    const parent = await mkdtemp("/tmp/t7cli-"); cleanup.push(() => rm(parent, { recursive: true, force: true }));
    const dir = join(parent, `matrix-terminal-${randomUUID().replaceAll('-', '')}`); await mkdir(dir, { mode: 0o700 });
    const path = join(dir, 'routine.sock'); let received = '', ended = false;
    const server = createServer(socket => { socket.setEncoding('utf8'); socket.on('end', () => ended = true); socket.on('data', data => {
      received += data;
      setTimeout(() => { expect(ended).toBe(false); socket.end(JSON.stringify({v:1,error:{code:'permission_denied',message:ROUTINE_CLI_SAFE_ERRORS.permission_denied}})+'\n'); }, 20);
    }); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); }); cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    await expect(executeTerminalRoutineOperation({ operation: 'list' }, new AbortController().signal, path)).rejects.toMatchObject({ code: 'permission_denied' });
    expect(JSON.parse(received)).toEqual({ operation: 'list' });
  });
});

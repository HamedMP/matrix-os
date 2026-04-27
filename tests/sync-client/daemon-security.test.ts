import { describe, expect, it } from "vitest";
import {
  IPC_MAX_BUFFER_BYTES,
  IPC_MAX_CONNECTIONS,
  IPC_SOCKET_DIR_MODE,
  IPC_SOCKET_MODE,
} from "../../packages/sync-client/src/daemon/ipc-server.js";

describe("daemon IPC socket security", () => {
  it("uses owner-only socket permissions and bounded connection buffers", () => {
    expect(IPC_SOCKET_DIR_MODE).toBe(0o700);
    expect(IPC_SOCKET_MODE).toBe(0o600);
    expect(IPC_MAX_CONNECTIONS).toBe(10);
    expect(IPC_MAX_BUFFER_BYTES).toBe(65_536);
  });
});

import type { CodingSessionClient, CodingAttachResult } from "./coding-sessions.js";
import type { TuiShellSessionClient } from "./shell-sessions.js";

export interface ReturnedToTui {
  returned: true;
}

export async function attachShellSession(shellClient: Pick<TuiShellSessionClient, "attach">, name: string): Promise<ReturnedToTui> {
  await shellClient.attach(name);
  return { returned: true };
}

export async function observeCodingSession(client: Pick<CodingSessionClient, "observe">, id: string): Promise<CodingAttachResult> {
  return client.observe(id);
}

export async function takeoverCodingSession(client: Pick<CodingSessionClient, "takeover">, id: string): Promise<CodingAttachResult> {
  return client.takeover(id);
}

export async function killCodingSession(client: Pick<CodingSessionClient, "kill">, id: string): Promise<{ killed: true }> {
  await client.kill(id);
  return { killed: true };
}

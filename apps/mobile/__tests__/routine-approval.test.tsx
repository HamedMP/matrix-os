jest.mock("../components/ui/Sheet", () => ({ Sheet: () => null }));
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { BotInteraction } from "@matrix-os/contracts";
import { PendingInteraction } from "../components/agents/interactions/PendingInteraction";

afterEach(cleanup);
const preview = { proposal: { name: "Morning brief", prompt: "Write a short private brief.",
  schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "Asia/Shanghai" },
  selection: { instanceId: "matrix_chatgpt_plan", model: "gpt-6-luna" }, authorizedEffects: ["read"] },
  source: { accountId: "private-account", computerId: "Test Computer", grantRevision: 3, definitionRevision: 2 } };
const interaction: BotInteraction = { interactionId: "in_abcdefgh", chatId: "chat_fixture", agentId: "bot_fixture", taskId: "task_fixture",
  kind: "approval", blocking: true, status: "pending", expiresAt: "2099-01-01T00:00:00.000Z", revision: 7,
  payload: { kind: "approval", tool: "routine.activate", audience: "direct", policyRevision: 3, argsDigest: "a".repeat(64), preview: JSON.stringify(preview) } };
function draw(value = interaction) {
  const onResolve = jest.fn(async () => ({ interaction: { ...value, status: "resolved" as const, revision: 8 } }));
  render(<PendingInteraction interaction={value} onResolve={onResolve} onRefresh={jest.fn()} />);
  return onResolve;
}
it("explains the standing task with collapsed technical data and submits only an explicit bound approval", async () => {
  const resolve = draw();
  expect(screen.getByRole("header", { name: "Schedule Morning brief" })).toBeTruthy();
  expect(screen.getByText("Weekdays at 09:00")).toBeTruthy();
  expect(screen.getByText("Asia/Shanghai")).toBeTruthy();
  expect(screen.queryByText(JSON.stringify(preview))).toBeNull();
  expect(resolve).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Approve schedule" }));
  await waitFor(() => expect(resolve).toHaveBeenCalledWith(interaction.interactionId, { kind: "approval", baseRevision: 7, decision: "approve" }));
});
it("allows cancellation but never approval of malformed schedule data", async () => {
  const resolve = draw({ ...interaction, payload: { ...interaction.payload!, kind: "approval", tool: "routine.activate", audience: "direct", argsDigest: "a".repeat(64), policyRevision: 3, preview: "{broken" } });
  expect(screen.queryByRole("button", { name: "Approve schedule" })).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(resolve).toHaveBeenCalledWith(interaction.interactionId, { kind: "approval", baseRevision: 7, decision: "deny" }));
});

it("keeps an expired task readable without granting approval", () => {
  draw({...interaction, expiresAt: "2000-01-01T00:00:00.000Z"});
  expect(screen.getByText("Write a short private brief.")).toBeTruthy();
  expect(screen.getByText("Expired")).toBeTruthy();
  expect(screen.queryByRole("button", {name: "Approve schedule"})).toBeNull();
});
it("fences outdated edit approval while retaining its cancellation", async () => {
  const edit = {...preview, source: {...preview.source, routineId: "rt_" + "a".repeat(24), baseRoutineRevision: 2}};
  const resolve = jest.fn();
  render(<PendingInteraction interaction={{...interaction, payload: {...interaction.payload!, kind: "approval", tool: "routine.activate", audience: "direct", argsDigest: "a".repeat(64), policyRevision: 3, preview: JSON.stringify(edit)}}}
    currentRoutineRevision={3} onResolve={resolve} onRefresh={jest.fn()} />);
  fireEvent.press(screen.getByRole("button", {name: "Approve changes"}));
  expect(resolve).not.toHaveBeenCalled();
  expect(screen.getByRole("button", {name: "Approve changes"}).props.accessibilityState.disabled).toBe(true);
});
it("does not approve an expired task when a displayed button is pressed later", () => {
  const time = jest.spyOn(Date, "now");
  const soon = new Date(Date.now() + 60_000).toISOString();
  const resolve = draw({...interaction, expiresAt: soon});
  // Date constructor, not model text, determines the permission-card lifecycle.
  const OriginalDate = Date;
  const fake = class extends OriginalDate { constructor(...args: any[]) { super(args.length ? args[0] : Date.parse(soon) + 1); } };
  global.Date = fake as typeof Date;
  try { fireEvent.press(screen.getByRole("button", {name: "Approve schedule"})); expect(resolve).not.toHaveBeenCalled(); }
  finally { global.Date = OriginalDate; time.mockRestore(); }
});

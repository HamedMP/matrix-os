import {
  CanonicalChatIdSchema,
  type MatrixComputer,
  type MatrixComputerList,
} from "@matrix-os/contracts";
export function messagingJourneyTarget(
  chat: unknown,
): "/(drawer)" | { pathname: "/(drawer)"; params: { chat: string } } {
  const parsed = CanonicalChatIdSchema.safeParse(chat);
  return parsed.success
    ? { pathname: "/(drawer)", params: { chat: parsed.data } }
    : "/(drawer)";
}
/** Authentication must return through the normal readiness gate. */
export function messagingSignInTarget(
  chat: unknown,
): "/(drawer)" | { pathname: "/"; params: { chat: string } } {
  const parsed = CanonicalChatIdSchema.safeParse(chat);
  return parsed.success
    ? { pathname: "/", params: { chat: parsed.data } }
    : "/(drawer)";
}
/** Inventory is owner-authorized and schema-validated by fetchComputers. */
export function messagingPrimaryComputer(
  inventory: MatrixComputerList,
): MatrixComputer {
  const primary = inventory.items.find(
    (item) =>
      item.runtimeSlot === "primary" &&
      item.kind === "customer" &&
      item.availability === "available",
  );
  if (!primary) throw new Error("Main Computer unavailable");
  return primary;
}

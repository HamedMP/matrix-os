import type { MatrixComputerList } from "@matrix-os/contracts";
import type { AuthStatus } from "../auth/auth-service";

type Computer = Pick<MatrixComputerList["items"][number], "runtimeSlot" | "handle" | "availability">;

interface InventoryAuth {
  getStatus(): AuthStatus;
  listRuntimeComputers(): Promise<{ items: readonly Computer[]; hasMore: boolean }>;
}

export async function readMatrixInventory(auth: InventoryAuth, ownerId: string) {
  const before = auth.getStatus();
  if (!before.signedIn || before.userId !== ownerId) throw new Error("Computer inventory unavailable");

  const { items, hasMore } = await auth.listRuntimeComputers();
  const after = auth.getStatus();
  if (!after.signedIn || after.userId !== ownerId || after.authGeneration !== before.authGeneration) {
    throw new Error("Computer inventory session changed");
  }

  // The responding primary Gateway already reports itself. A starting or temporarily
  // unavailable computer stays discoverable without claiming a working terminal path.
  const machines = items.filter(computer => computer.runtimeSlot !== "primary").map(computer => ({
    name: computer.handle,
    runtimeSlot: computer.runtimeSlot,
    source: "matrix" as const,
    state: computer.availability === "available" ? "connected" as const : "unknown" as const,
  }));
  return { machines, partial: hasMore };
}
